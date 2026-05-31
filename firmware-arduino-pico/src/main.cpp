#include <Arduino.h>
#include <SPI.h>
#include <MFRC522.h>

// Wiring: RC522 <-> Raspberry Pi Pico / RP2040
// 3.3V -> 3V3 OUT
// GND  -> GND
// SDA/SS/NSS -> GP17
// SCK -> GP18
// MOSI -> GP19
// MISO -> GP16
// RST -> GP20
// IRQ -> GP21 (wired but not required for this first version)

static constexpr uint8_t PIN_SPI_MISO = 16;
static constexpr uint8_t PIN_RFID_SS  = 17;
static constexpr uint8_t PIN_SPI_SCK  = 18;
static constexpr uint8_t PIN_SPI_MOSI = 19;
static constexpr uint8_t PIN_RFID_RST = 20;
static constexpr uint8_t PIN_RFID_IRQ = 21;

MFRC522 rfid(PIN_RFID_SS, PIN_RFID_RST);
MFRC522::MIFARE_Key defaultKey;

String inputLine;
String lastUid;
unsigned long lastPollMs = 0;
bool cardPresent = false;

static String statusName(MFRC522::StatusCode status) {
  return String(rfid.GetStatusCodeName(status));
}

static bool isHexChar(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  return -1;
}

static String bytesToHex(const byte* data, byte len, bool spaces = false) {
  const char* hex = "0123456789ABCDEF";
  String out;
  for (byte i = 0; i < len; i++) {
    if (spaces && i > 0) out += ' ';
    out += hex[(data[i] >> 4) & 0x0F];
    out += hex[data[i] & 0x0F];
  }
  return out;
}

static bool hexToBytes(String hex, byte* output, size_t expectedBytes) {
  hex.trim();
  hex.replace(" ", "");
  hex.replace(":", "");
  hex.replace("-", "");
  if (hex.length() != (int)(expectedBytes * 2)) return false;

  for (size_t i = 0; i < expectedBytes; i++) {
    char hi = hex[i * 2];
    char lo = hex[i * 2 + 1];
    if (!isHexChar(hi) || !isHexChar(lo)) return false;
    output[i] = (byte)((hexNibble(hi) << 4) | hexNibble(lo));
  }
  return true;
}

static String currentUidHex() {
  return bytesToHex(rfid.uid.uidByte, rfid.uid.size, false);
}

static void emitReady() {
  Serial.println("READY RP2040_RFID_USB 0.1.0");
  Serial.println("PINS SS=17 SCK=18 MOSI=19 MISO=16 RST=20 IRQ=21");
  Serial.println("TYPE HELP");
}

static void printHelp() {
  Serial.println("OK COMMANDS");
  Serial.println("  PING");
  Serial.println("  VERSION");
  Serial.println("  SCAN");
  Serial.println("  READ_BLOCK <block> [keyAhex12]");
  Serial.println("  WRITE_BLOCK <block> <hex32> [keyAhex12]");
  Serial.println("  DUMP <startBlock> <endBlock> [keyAhex12]");
  Serial.println("NOTES");
  Serial.println("  Default key is FFFFFFFFFFFF");
  Serial.println("  WRITE_BLOCK refuses block 0 and sector trailer blocks for safety");
}

static bool selectCard() {
  // First try the normal path.
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    return true;
  }

  // Then try waking an already-present card. This helps when repeatedly clicking
  // read/write in the web UI while the same card is still on the antenna.
  byte atqa[2];
  byte atqaSize = sizeof(atqa);
  MFRC522::StatusCode wake = rfid.PICC_WakeupA(atqa, &atqaSize);
  if (wake == MFRC522::STATUS_OK || wake == MFRC522::STATUS_COLLISION) {
    return rfid.PICC_ReadCardSerial();
  }

  return false;
}

static void stopCardCrypto() {
  rfid.PCD_StopCrypto1();
}

static bool loadKey(const String& keyHex, MFRC522::MIFARE_Key& key) {
  if (keyHex.length() == 0) {
    for (byte i = 0; i < 6; i++) key.keyByte[i] = 0xFF;
    return true;
  }

  byte parsed[6];
  if (!hexToBytes(keyHex, parsed, 6)) return false;
  for (byte i = 0; i < 6; i++) key.keyByte[i] = parsed[i];
  return true;
}

static bool isSectorTrailer(byte block) {
  return block % 4 == 3;
}

static byte trailerForBlock(byte block) {
  return (block / 4) * 4 + 3;
}

static bool authenticateBlock(byte block, const String& keyHex) {
  MFRC522::MIFARE_Key key;
  if (!loadKey(keyHex, key)) {
    Serial.println("ERR BAD_KEY expected 12 hex chars");
    return false;
  }

  byte trailerBlock = trailerForBlock(block);
  MFRC522::StatusCode status = rfid.PCD_Authenticate(
    MFRC522::PICC_CMD_MF_AUTH_KEY_A,
    trailerBlock,
    &key,
    &(rfid.uid)
  );

  if (status != MFRC522::STATUS_OK) {
    Serial.print("ERR AUTH ");
    Serial.println(statusName(status));
    return false;
  }

  return true;
}

static void commandPing() {
  Serial.println("OK PONG");
}

static void commandVersion() {
  byte version = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.print("OK VERSION 0x");
  if (version < 0x10) Serial.print('0');
  Serial.println(version, HEX);
}

static void commandScan() {
  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }

  Serial.print("OK UID=");
  Serial.print(currentUidHex());
  Serial.print(" SAK=0x");
  if (rfid.uid.sak < 0x10) Serial.print('0');
  Serial.print(rfid.uid.sak, HEX);
  Serial.print(" TYPE=");
  MFRC522::PICC_Type type = rfid.PICC_GetType(rfid.uid.sak);
  Serial.println(rfid.PICC_GetTypeName(type));
}

static void commandReadBlock(byte block, const String& keyHex) {
  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }

  if (!authenticateBlock(block, keyHex)) {
    stopCardCrypto();
    return;
  }

  byte buffer[18];
  byte size = sizeof(buffer);
  MFRC522::StatusCode status = rfid.MIFARE_Read(block, buffer, &size);
  stopCardCrypto();

  if (status != MFRC522::STATUS_OK) {
    Serial.print("ERR READ ");
    Serial.println(statusName(status));
    return;
  }

  Serial.print("OK BLOCK=");
  Serial.print(block);
  Serial.print(" DATA=");
  Serial.println(bytesToHex(buffer, 16, false));
}

static void commandWriteBlock(byte block, const String& dataHex, const String& keyHex) {
  if (block == 0) {
    Serial.println("ERR REFUSE_BLOCK_ZERO");
    return;
  }

  if (isSectorTrailer(block)) {
    Serial.println("ERR REFUSE_SECTOR_TRAILER");
    return;
  }

  byte data[16];
  if (!hexToBytes(dataHex, data, 16)) {
    Serial.println("ERR BAD_DATA expected 32 hex chars");
    return;
  }

  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }

  if (!authenticateBlock(block, keyHex)) {
    stopCardCrypto();
    return;
  }

  MFRC522::StatusCode status = rfid.MIFARE_Write(block, data, 16);
  stopCardCrypto();

  if (status != MFRC522::STATUS_OK) {
    Serial.print("ERR WRITE ");
    Serial.println(statusName(status));
    return;
  }

  Serial.print("OK WROTE BLOCK=");
  Serial.print(block);
  Serial.print(" DATA=");
  Serial.println(bytesToHex(data, 16, false));
}

static void commandDump(byte startBlock, byte endBlock, const String& keyHex) {
  if (endBlock < startBlock) {
    Serial.println("ERR BAD_RANGE");
    return;
  }

  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }

  Serial.print("OK DUMP_BEGIN UID=");
  Serial.println(currentUidHex());

  byte lastTrailer = 255;
  bool authed = false;

  for (byte block = startBlock; block <= endBlock; block++) {
    byte trailer = trailerForBlock(block);
    if (!authed || trailer != lastTrailer) {
      stopCardCrypto();
      authed = authenticateBlock(block, keyHex);
      lastTrailer = trailer;
      if (!authed) {
        Serial.print("BLOCK=");
        Serial.print(block);
        Serial.println(" ERR AUTH");
        continue;
      }
    }

    byte buffer[18];
    byte size = sizeof(buffer);
    MFRC522::StatusCode status = rfid.MIFARE_Read(block, buffer, &size);
    Serial.print("BLOCK=");
    Serial.print(block);
    if (status == MFRC522::STATUS_OK) {
      Serial.print(" DATA=");
      Serial.println(bytesToHex(buffer, 16, false));
    } else {
      Serial.print(" ERR ");
      Serial.println(statusName(status));
    }

    if (block == 255) break;
  }

  stopCardCrypto();
  Serial.println("OK DUMP_END");
}

static String nextToken(String& rest) {
  rest.trim();
  if (rest.length() == 0) return "";
  int idx = rest.indexOf(' ');
  if (idx < 0) {
    String token = rest;
    rest = "";
    token.trim();
    return token;
  }
  String token = rest.substring(0, idx);
  rest = rest.substring(idx + 1);
  token.trim();
  return token;
}

static void handleCommand(String line) {
  line.trim();
  if (line.length() == 0) return;

  String rest = line;
  String cmd = nextToken(rest);
  cmd.toUpperCase();

  if (cmd == "PING") {
    commandPing();
  } else if (cmd == "HELP") {
    printHelp();
  } else if (cmd == "VERSION") {
    commandVersion();
  } else if (cmd == "SCAN" || cmd == "UID" || cmd == "READ_UID") {
    commandScan();
  } else if (cmd == "READ_BLOCK") {
    String blockStr = nextToken(rest);
    String keyHex = nextToken(rest);
    if (blockStr.length() == 0) {
      Serial.println("ERR USAGE READ_BLOCK <block> [keyAhex12]");
      return;
    }
    int block = blockStr.toInt();
    if (block < 0 || block > 255) {
      Serial.println("ERR BAD_BLOCK");
      return;
    }
    commandReadBlock((byte)block, keyHex);
  } else if (cmd == "WRITE_BLOCK") {
    String blockStr = nextToken(rest);
    String dataHex = nextToken(rest);
    String keyHex = nextToken(rest);
    if (blockStr.length() == 0 || dataHex.length() == 0) {
      Serial.println("ERR USAGE WRITE_BLOCK <block> <hex32> [keyAhex12]");
      return;
    }
    int block = blockStr.toInt();
    if (block < 0 || block > 255) {
      Serial.println("ERR BAD_BLOCK");
      return;
    }
    commandWriteBlock((byte)block, dataHex, keyHex);
  } else if (cmd == "DUMP") {
    String startStr = nextToken(rest);
    String endStr = nextToken(rest);
    String keyHex = nextToken(rest);
    if (startStr.length() == 0 || endStr.length() == 0) {
      Serial.println("ERR USAGE DUMP <startBlock> <endBlock> [keyAhex12]");
      return;
    }
    int startBlock = startStr.toInt();
    int endBlock = endStr.toInt();
    if (startBlock < 0 || startBlock > 255 || endBlock < 0 || endBlock > 255) {
      Serial.println("ERR BAD_BLOCK");
      return;
    }
    commandDump((byte)startBlock, (byte)endBlock, keyHex);
  } else {
    Serial.print("ERR UNKNOWN_COMMAND ");
    Serial.println(cmd);
  }
}

static void readSerialCommands() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      String line = inputLine;
      inputLine = "";
      handleCommand(line);
    } else {
      if (inputLine.length() < 192) {
        inputLine += c;
      } else {
        inputLine = "";
        Serial.println("ERR LINE_TOO_LONG");
      }
    }
  }
}

static void pollCardEvents() {
  unsigned long now = millis();
  if (now - lastPollMs < 350) return;
  lastPollMs = now;

  // For this quick test firmware, IRQ is wired but not used as the only wake source.
  // RC522 interrupt setup is easy to get wrong; polling keeps the browser workflow reliable.
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uid = currentUidHex();
    if (!cardPresent || uid != lastUid) {
      cardPresent = true;
      lastUid = uid;
      Serial.print("EVENT CARD_PRESENT UID=");
      Serial.println(uid);
    }
    rfid.PICC_HaltA();
    stopCardCrypto();
  } else {
    // Very lightweight absence detection. It won't be perfect, but it avoids spamming.
    // Manual SCAN remains authoritative.
  }
}

void setup() {
  pinMode(PIN_RFID_IRQ, INPUT_PULLUP);

  Serial.begin(115200);
  unsigned long start = millis();
  while (!Serial && millis() - start < 2500) {
    delay(10);
  }

  SPI.setRX(PIN_SPI_MISO);
  SPI.setCS(PIN_RFID_SS);
  SPI.setSCK(PIN_SPI_SCK);
  SPI.setTX(PIN_SPI_MOSI);
  SPI.begin();

  rfid.PCD_Init();

  for (byte i = 0; i < 6; i++) defaultKey.keyByte[i] = 0xFF;

  emitReady();
  commandVersion();
}

void loop() {
  readSerialCommands();
  pollCardEvents();
  delay(2);
}
