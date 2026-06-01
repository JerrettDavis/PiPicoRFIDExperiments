#include <Arduino.h>
#include <SPI.h>
#include <MFRC522.h>
#include <MFRC522Extended.h>  // v0.3: RATS/T=CL + inherited magic-UID helpers

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

// v0.3: MFRC522Extended is a drop-in subclass of MFRC522 — all existing
// MFRC522:: enums/constants and Classic/Ultralight calls keep working, and we
// additionally gain PICC_RequestATS / TCL_Transceive / MIFARE_OpenUidBackdoor /
// MIFARE_SetUid.
MFRC522Extended rfid(PIN_RFID_SS, PIN_RFID_RST);
MFRC522::MIFARE_Key defaultKey;

String inputLine;
String lastUid;
unsigned long lastPollMs = 0;
bool cardPresent = false;

// v0.3: ATQA captured during selectCard(), surfaced by SCAN.
uint16_t lastAtqa = 0;

// RESCAN: while the SAME card stays continuously present, re-emit
// EVENT CARD_PRESENT every rescanIntervalMs (0 = disabled, emit once per
// physical insertion). millis()-based; the periodic re-emit does NOT re-fire
// the LED blink burst (only a genuinely new insertion does).
unsigned long rescanIntervalMs = 0;
unsigned long lastEmitMs = 0;

// --- Onboard LED indicator (local-only; does not affect serial protocol) ---
// Model: the LED has a RESTING state derived purely from debounced card
// presence -- SOLID ON while a card is present, OFF when none -- with a brief
// transient FLASH overlay fired on each SCAN to indicate scan activity. All
// timing is millis()-based (non-blocking): nothing here ever blocks the serial
// command handling or the RC522 poll cadence.
static constexpr unsigned long LED_FLASH_MS = 100;   // SCAN flash-pulse duration (ms)

// Debounced presence used ONLY to drive the LED. We cannot trust a single poll's
// PICC_IsNewCardPresent() for the "card gone" decision: the poll halts the card
// after reading it (PICC_HaltA), so a card still on the antenna is not reported
// as "new" every poll and a single absent reading is normal. To avoid flicker we
// require LED_ABSENT_DEBOUNCE consecutive absent polls before declaring removal.
// This state is local to the LED and never affects the EVENT CARD_PRESENT text.
static constexpr uint8_t LED_ABSENT_DEBOUNCE = 3;    // consecutive absent polls = gone
static bool ledPresent = false;                      // debounced presence for the LED
static uint8_t ledAbsentCount = 0;                   // consecutive absent-poll counter

// Transient SCAN flash overlay: for LED_FLASH_MS after ledFlashStartMs the LED
// shows the OPPOSITE of its resting state, then snaps back to resting. Timed via
// rollover-safe unsigned elapsed-time subtraction (not an absolute deadline).
static unsigned long ledFlashStartMs = 0;

static void ledWrite(bool on) {
  digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
}

// Resting LED state = ON if a card is present (debounced), else OFF.
static bool ledRestingState() {
  return ledPresent;
}

// Future-proof hook: called exactly once on the genuine card-detection RISING
// edge (the same edge where ledPresent transitions false -> true). Central place
// to add a speaker beep later. For now it just guarantees the LED solid-on.
static void onCardIntake() {
  // TODO: speaker beep on intake
  ledWrite(true);  // card just arrived -> resting state is ON
}

// Called from pollCardEvents() on debounced presence edges.
// present==true is only ever passed on the genuine rising edge (caller gates it
// on !ledPresent), so this drives straight to SOLID ON via onCardIntake() with
// no blink burst. present==false is the debounced "card gone" falling edge.
static void ledOnCardState(bool present) {
  if (present) {
    onCardIntake();          // rising edge -> solid ON (+ future beep)
  } else {
    ledWrite(false);         // falling edge -> OFF (unless a flash overlay is active)
  }
}

// Fire a brief non-blocking flash pulse to indicate SCAN activity. The pulse
// shows the opposite of the resting state for LED_FLASH_MS, then ledUpdate()
// restores the resting state. No card + SCAN -> blink on then off; card present
// + SCAN -> blink off then back to solid on.
static void ledFlashScan() {
  ledFlashStartMs = millis();
  ledWrite(!ledRestingState());  // immediately show the inverted (flash) level
}

// Non-blocking LED tick: applies the flash overlay if active, else the resting
// state. Safe to call every loop iteration. The elapsed-time test
// (now - start < dur) on unsigned millis() is rollover-safe across the 49.7-day
// wrap, unlike an absolute (now < deadline) comparison.
static void ledUpdate() {
  if (millis() - ledFlashStartMs < LED_FLASH_MS) {
    ledWrite(!ledRestingState());  // flash overlay active
  } else {
    ledWrite(ledRestingState());   // resting: ON if card present, else OFF
  }
}

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
  Serial.println("READY RP2040_RFID_USB 0.3.0");
  Serial.println("PINS SS=17 SCK=18 MOSI=19 MISO=16 RST=20 IRQ=21");
  Serial.println("TYPE HELP");
}

static void printHelp() {
  Serial.println("OK COMMANDS");
  Serial.println("  PING");
  Serial.println("  VERSION");
  Serial.println("  RESCAN [ms]");
  Serial.println("  SCAN");
  Serial.println("  READ_BLOCK <block> [keyAhex12]");
  Serial.println("  WRITE_BLOCK <block> <hex32> [keyAhex12]");
  Serial.println("  DUMP <startBlock> <endBlock> [keyAhex12]");
  Serial.println("  READ_PAGE <page>");
  Serial.println("  WRITE_PAGE <page> <hex8>");
  Serial.println("  CLONE_READ");
  Serial.println("  CLONE_READ_UL");
  Serial.println("  MAGIC_DETECT");
  Serial.println("  CLONE_UID <block0hex32> METHOD=<GEN1A|GEN2|AUTO>");
  Serial.println("  WRITE_BLOCK_RAW <block> <hex32> KEY=<hex12>");
  Serial.println("  WRITE_TRAILER <trailerBlock> <hex32> KEY=<hex12>");
  Serial.println("  WRITE_PAGE_RAW <page> <hex8>");
  Serial.println("  ATS");
  Serial.println("  APDU <hexCAPDU>");
  Serial.println("NOTES");
  Serial.println("  Default key is FFFFFFFFFFFF");
  Serial.println("  WRITE_BLOCK refuses block 0 and sector trailer blocks for safety");
  Serial.println("  RESCAN <ms>: re-emit EVENT CARD_PRESENT every ms while same card present (0=off)");
  Serial.println("  READ_PAGE/WRITE_PAGE target Ultralight/NTAG (no auth); WRITE_PAGE refuses pages 0-3");
  Serial.println("  CLONE_READ dumps all readable sectors using a built-in key dictionary");
  Serial.println("  MAGIC_DETECT/CLONE_UID need magic (Gen1a/Gen2) cards; normal UIDs are unchangeable");
  Serial.println("  CLONE_UID supports 4-byte UID targets only (Gen1a and Gen2); 7-byte UIDs rejected");
  Serial.println("  WRITE_PAGE_RAW allows pages 0-2 (magic NTAG); refuses page 3 OTP and cascade byte");
  Serial.println("  ATS/APDU target ISO-14443-4 cards; APDU req/resp limited to 60 bytes");
}

static bool selectCard() {
  // First try the normal path. PICC_IsNewCardPresent() issues REQA but does not
  // expose the ATQA, so on success we follow up with a WUPA to capture ATQA for
  // the SCAN response. WUPA also re-selects the same card harmlessly.
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    byte atqa[2];
    byte atqaSize = sizeof(atqa);
    MFRC522::StatusCode w = rfid.PICC_WakeupA(atqa, &atqaSize);
    if (w == MFRC522::STATUS_OK || w == MFRC522::STATUS_COLLISION) {
      lastAtqa = (uint16_t)atqa[0] | ((uint16_t)atqa[1] << 8);
      return rfid.PICC_ReadCardSerial();
    }
    return true;  // selected, but ATQA capture failed; keep prior lastAtqa
  }

  // Then try waking an already-present card. This helps when repeatedly clicking
  // read/write in the web UI while the same card is still on the antenna.
  byte atqa[2];
  byte atqaSize = sizeof(atqa);
  MFRC522::StatusCode wake = rfid.PICC_WakeupA(atqa, &atqaSize);
  if (wake == MFRC522::STATUS_OK || wake == MFRC522::STATUS_COLLISION) {
    lastAtqa = (uint16_t)atqa[0] | ((uint16_t)atqa[1] << 8);
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

// --- Card-type classification (uses base miguelbalboa/MFRC522 PICC_GetType) ---
enum class CardFamily { CLASSIC, ULTRALIGHT, ISO4, UNKNOWN };

static CardFamily cardFamily(MFRC522::PICC_Type type) {
  switch (type) {
    case MFRC522::PICC_TYPE_MIFARE_MINI:
    case MFRC522::PICC_TYPE_MIFARE_1K:
    case MFRC522::PICC_TYPE_MIFARE_4K:
      return CardFamily::CLASSIC;
    case MFRC522::PICC_TYPE_MIFARE_UL:   // Ultralight + NTAG21x
      return CardFamily::ULTRALIGHT;
    case MFRC522::PICC_TYPE_ISO_14443_4:
    case MFRC522::PICC_TYPE_ISO_18092:
      return CardFamily::ISO4;
    default:
      return CardFamily::UNKNOWN;
  }
}

// Stable, no-space token for the SCAN response and ERR messages.
static String typeToken(MFRC522::PICC_Type type) {
  switch (type) {
    case MFRC522::PICC_TYPE_MIFARE_MINI: return "MIFARE_MINI";
    case MFRC522::PICC_TYPE_MIFARE_1K:   return "MIFARE_1K";
    case MFRC522::PICC_TYPE_MIFARE_4K:   return "MIFARE_4K";
    case MFRC522::PICC_TYPE_MIFARE_UL:   return "MIFARE_UL";
    case MFRC522::PICC_TYPE_MIFARE_PLUS: return "MIFARE_PLUS";
    case MFRC522::PICC_TYPE_ISO_14443_4: return "ISO_14443_4";
    case MFRC522::PICC_TYPE_ISO_18092:   return "ISO_18092";
    default:                             return "UNKNOWN";
  }
}

// Classify the currently-selected card (rfid.uid must be valid).
static CardFamily currentCardFamily() {
  return cardFamily(rfid.PICC_GetType(rfid.uid.sak));
}

static String currentTypeToken() {
  return typeToken(rfid.PICC_GetType(rfid.uid.sak));
}

// MIFARE Classic sector-trailer geometry. 1K/Mini: 16-block sectors of 4 blocks
// (trailer = sectorStart+3). 4K sectors 32-39 are 16 blocks each (trailer =
// sectorStart+15). This helper returns the correct trailer for any 0-255 block.
static byte trailerForBlock(byte block) {
  if (block < 128) {
    // Sectors 0-31: 4 blocks each.
    return (block / 4) * 4 + 3;
  }
  // Sectors 32-39 (blocks 128-255): 16 blocks each, trailer = start+15.
  byte sectorStart = 128 + ((block - 128) / 16) * 16;
  return sectorStart + 15;
}

static bool isSectorTrailer(byte block) {
  return block == trailerForBlock(block);
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

// ============================================================================
// v0.3 cloning primitives — helpers
// ============================================================================

// Common MIFARE Classic keys, tried as both Key A and Key B per sector.
static const char* const KEY_DICT[] = {
  "FFFFFFFFFFFF", "000000000000", "A0A1A2A3A4A5", "B0B1B2B3B4B5",
  "D3F7D3F7D3F7", "4D3A99C351DD", "1A982C7E459A", "AABBCCDDEEFF",
  "714C5C886E97", "587EE5F9350F", "A396EFA4E24F"
};
static const uint8_t KEY_DICT_COUNT = sizeof(KEY_DICT) / sizeof(KEY_DICT[0]);

static byte sectorCount(MFRC522::PICC_Type type) {
  switch (type) {
    case MFRC522::PICC_TYPE_MIFARE_MINI: return 5;
    case MFRC522::PICC_TYPE_MIFARE_1K:   return 16;
    case MFRC522::PICC_TYPE_MIFARE_4K:   return 40;
    default:                             return 0;
  }
}

static byte firstBlockOfSector(byte sector) {
  if (sector < 32) return sector * 4;
  return 128 + (sector - 32) * 16;
}

static byte blocksInSector(byte sector) {
  return (sector < 32) ? 4 : 16;
}

static byte bccClassic(const byte* uid4) {
  return uid4[0] ^ uid4[1] ^ uid4[2] ^ uid4[3];
}

// Try every dictionary key (Key A then Key B) authenticating against a sector's
// TRAILER block. On success, crypto is left OPEN (caller must StopCrypto1 when
// done) and the matching key hex + type ('A'/'B') are returned via out params.
static bool authSectorWithDict(byte sector, String& outKeyHex, char& outKeyType) {
  byte trailer = trailerForBlock(firstBlockOfSector(sector));
  MFRC522::MIFARE_Key key;

  for (byte cmd = 0; cmd < 2; cmd++) {
    byte authCmd = (cmd == 0) ? MFRC522::PICC_CMD_MF_AUTH_KEY_A
                              : MFRC522::PICC_CMD_MF_AUTH_KEY_B;
    for (uint8_t i = 0; i < KEY_DICT_COUNT; i++) {
      if (!loadKey(String(KEY_DICT[i]), key)) continue;
      MFRC522::StatusCode st = rfid.PCD_Authenticate(authCmd, trailer, &key, &(rfid.uid));
      if (st == MFRC522::STATUS_OK) {
        outKeyHex = String(KEY_DICT[i]);
        outKeyType = (cmd == 0) ? 'A' : 'B';
        return true;
      }
      // A failed auth can leave the PICC unselected; re-select before next try.
      rfid.PCD_StopCrypto1();
      byte atqa[2]; byte atqaSize = sizeof(atqa);
      rfid.PICC_WakeupA(atqa, &atqaSize);
      rfid.PICC_ReadCardSerial();
    }
  }
  return false;
}

// Gen1a "magic" backdoor open via the library helper. The library implementation
// does PICC_HaltA -> 0x40 (7 valid bits) -> 0x43 and expects an 0x0A ACK.
static bool magicOpenGen1a() {
  return rfid.MIFARE_OpenUidBackdoor(false);
}

// Documented fallback: send a short (7-bit) frame, e.g. the Gen1a 0x40 wakeup.
// Kept for reference/debugging; not used in the main path because the library
// helper above already implements the full backdoor handshake.
static MFRC522::StatusCode sendShortFrame(byte cmd, byte validBits) {
  byte back[4];
  byte backLen = sizeof(back);
  byte vb = validBits;
  return rfid.PCD_TransceiveData(&cmd, 1, back, &backLen, &vb, 0, false);
}

// SAFE Gen2 detection: dict-auth sector 0, read block 0, write the SAME bytes
// back, re-read and compare. Returns true only if the write succeeded AND the
// data is unchanged (i.e. block 0 is writable on this card). Never alters data.
static bool detectGen2Writable() {
  String kh; char kt;
  if (!authSectorWithDict(0, kh, kt)) return false;

  byte before[18]; byte sz = sizeof(before);
  if (rfid.MIFARE_Read(0, before, &sz) != MFRC522::STATUS_OK) {
    rfid.PCD_StopCrypto1();
    return false;
  }
  byte data16[16];
  memcpy(data16, before, 16);

  MFRC522::StatusCode w = rfid.MIFARE_Write(0, data16, 16);
  if (w != MFRC522::STATUS_OK) {
    rfid.PCD_StopCrypto1();
    return false;
  }
  byte after[18]; byte sz2 = sizeof(after);
  bool ok = (rfid.MIFARE_Read(0, after, &sz2) == MFRC522::STATUS_OK) &&
            (memcmp(before, after, 16) == 0);
  rfid.PCD_StopCrypto1();
  return ok;
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
  // Indicate scan activity with a brief non-blocking flash overlay. Fires on
  // every SCAN regardless of whether a card is found.
  ledFlashScan();

  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }

  // Normalized response: TYPE is a no-space token; SIZE is the UID byte length.
  Serial.print("OK UID=");
  Serial.print(currentUidHex());
  Serial.print(" SIZE=");
  Serial.print(rfid.uid.size);
  Serial.print(" SAK=0x");
  if (rfid.uid.sak < 0x10) Serial.print('0');
  Serial.print(rfid.uid.sak, HEX);
  Serial.print(" TYPE=");
  Serial.print(currentTypeToken());

  // v0.3: always surface ATQA (captured in selectCard).
  Serial.print(" ATQA=0x");
  if (lastAtqa < 0x1000) Serial.print('0');
  if (lastAtqa < 0x0100) Serial.print('0');
  if (lastAtqa < 0x0010) Serial.print('0');
  Serial.print(lastAtqa, HEX);

  // v0.3: for ISO-14443-4 cards, append ATS hex when RATS succeeds.
  if (currentCardFamily() == CardFamily::ISO4) {
    MFRC522Extended::Ats ats;
    if (rfid.PICC_RequestATS(&ats) == MFRC522::STATUS_OK && ats.size > 0) {
      Serial.print(" ATS=");
      Serial.print(bytesToHex(ats.data, ats.size, false));
    }
  }
  Serial.println();
}

static void commandReadBlock(byte block, const String& keyHex) {
  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }

  // Dispatch on card family BEFORE any auth so non-Classic cards never hit the
  // Classic Key-A path (which would return a confusing ERR AUTH Timeout).
  CardFamily fam = currentCardFamily();
  if (fam == CardFamily::ULTRALIGHT) {
    Serial.println("ERR WRONG_CARD_TYPE USE=READ_PAGE");
    rfid.PICC_HaltA();
    return;
  }
  if (fam != CardFamily::CLASSIC) {
    Serial.print("ERR UNSUPPORTED_CARD TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
    return;
  }

  if (!authenticateBlock(block, keyHex)) {
    rfid.PICC_HaltA();   // release the selected card on the early-exit path too
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

  // Dispatch on card family before any auth.
  CardFamily fam = currentCardFamily();
  if (fam == CardFamily::ULTRALIGHT) {
    Serial.println("ERR WRONG_CARD_TYPE USE=WRITE_PAGE");
    rfid.PICC_HaltA();
    return;
  }
  if (fam != CardFamily::CLASSIC) {
    Serial.print("ERR UNSUPPORTED_CARD TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
    return;
  }

  if (!authenticateBlock(block, keyHex)) {
    rfid.PICC_HaltA();   // release the selected card on the early-exit path too
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

  // Dispatch on card family before any auth.
  CardFamily fam = currentCardFamily();
  if (fam == CardFamily::ULTRALIGHT) {
    Serial.println("ERR WRONG_CARD_TYPE USE=READ_PAGE");
    rfid.PICC_HaltA();
    return;
  }
  if (fam != CardFamily::CLASSIC) {
    Serial.print("ERR UNSUPPORTED_CARD TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
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

// READ_PAGE: Ultralight/NTAG read (no auth). MIFARE_Read returns 16 bytes
// (4 pages) starting at the requested page.
static void commandReadPage(byte page) {
  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }

  CardFamily fam = currentCardFamily();
  if (fam == CardFamily::CLASSIC) {
    Serial.println("ERR WRONG_CARD_TYPE USE=READ_BLOCK");
    rfid.PICC_HaltA();
    stopCardCrypto();
    return;
  }
  if (fam != CardFamily::ULTRALIGHT) {
    Serial.print("ERR UNSUPPORTED_CARD TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
    return;
  }

  byte buffer[18];
  byte size = sizeof(buffer);
  MFRC522::StatusCode status = rfid.MIFARE_Read(page, buffer, &size);
  rfid.PICC_HaltA();  // Ultralight: halt only, no crypto to stop.

  if (status != MFRC522::STATUS_OK) {
    Serial.print("ERR READ ");
    Serial.println(statusName(status));
    return;
  }

  Serial.print("OK PAGE=");
  Serial.print(page);
  Serial.print(" DATA=");
  Serial.println(bytesToHex(buffer, 16, false));  // 4 pages = 32 hex chars
}

// WRITE_PAGE: Ultralight/NTAG write (no auth, 4 bytes per page). Refuses pages
// 0-3 (UID / lock bytes / OTP) to avoid bricking the tag.
static void commandWritePage(byte page, const String& dataHex) {
  byte data[4];
  if (!hexToBytes(dataHex, data, 4)) {
    Serial.println("ERR BAD_DATA expected 8 hex chars");
    return;
  }

  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }

  CardFamily fam = currentCardFamily();
  if (fam == CardFamily::CLASSIC) {
    Serial.println("ERR WRONG_CARD_TYPE USE=WRITE_BLOCK");
    rfid.PICC_HaltA();
    stopCardCrypto();
    return;
  }
  if (fam != CardFamily::ULTRALIGHT) {
    Serial.print("ERR UNSUPPORTED_CARD TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
    return;
  }

  if (page <= 3) {
    Serial.println("ERR REFUSE_PAGE");
    rfid.PICC_HaltA();
    return;
  }

  MFRC522::StatusCode status = rfid.MIFARE_Ultralight_Write(page, data, 4);
  rfid.PICC_HaltA();  // Ultralight: halt only.

  if (status != MFRC522::STATUS_OK) {
    Serial.print("ERR WRITE ");
    Serial.println(statusName(status));
    return;
  }

  Serial.print("OK WROTE_PAGE PAGE=");
  Serial.print(page);
  Serial.print(" DATA=");
  Serial.println(bytesToHex(data, 4, false));
}

// ============================================================================
// v0.3 cloning primitives — commands
// ============================================================================

// Print a trailer-relative hex byte helper for 0x-prefixed two-digit output.
static void printHex2(byte b) {
  if (b < 0x10) Serial.print('0');
  Serial.print(b, HEX);
}

// Full Classic read across all sectors using the key dictionary.
static void cloneReadClassic() {
  MFRC522::PICC_Type type = rfid.PICC_GetType(rfid.uid.sak);
  byte sectors = sectorCount(type);

  Serial.print("OK CLONE_BEGIN UID=");
  Serial.print(currentUidHex());
  Serial.print(" SIZE=");
  Serial.print(rfid.uid.size);
  Serial.print(" SAK=0x");
  printHex2(rfid.uid.sak);
  Serial.print(" TYPE=");
  Serial.print(currentTypeToken());
  Serial.print(" SECTORS=");
  Serial.println(sectors);

  byte okSectors = 0, failedSectors = 0;

  for (byte s = 0; s < sectors; s++) {
    String keyHex; char keyType;
    bool authed = authSectorWithDict(s, keyHex, keyType);

    Serial.print("SECTOR=");
    Serial.print(s);
    Serial.print(" KEY=");
    if (authed) {
      Serial.print(keyHex);
      Serial.print(" KEYTYPE=");
      Serial.print(keyType);
      Serial.println(" STATUS=OK");
    } else {
      Serial.print("------------");
      Serial.println(" KEYTYPE=NONE STATUS=FAILED");
      failedSectors++;
      // Emit one BLOCK=<b> ERR=AUTH_FAILED line per block of the failed sector
      // so the host (web image/panel + e2e test) sees the failed blocks on real
      // hardware, matching the mock. No data is read (auth never succeeded).
      byte ffirst = firstBlockOfSector(s);
      byte fcount = blocksInSector(s);
      for (byte b = ffirst; b < ffirst + fcount; b++) {
        Serial.print("BLOCK=");
        Serial.print(b);
        Serial.println(" ERR=AUTH_FAILED");
      }
      continue;
    }

    okSectors++;
    byte first = firstBlockOfSector(s);
    byte count = blocksInSector(s);
    for (byte b = first; b < first + count; b++) {
      byte buffer[18]; byte sz = sizeof(buffer);
      MFRC522::StatusCode st = rfid.MIFARE_Read(b, buffer, &sz);
      Serial.print("BLOCK=");
      Serial.print(b);
      if (st == MFRC522::STATUS_OK) {
        Serial.print(" DATA=");
        Serial.println(bytesToHex(buffer, 16, false));
      } else {
        Serial.print(" ERR=");
        Serial.println(statusName(st));
      }
    }
    rfid.PCD_StopCrypto1();
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  Serial.print("OK CLONE_END OK_SECTORS=");
  Serial.print(okSectors);
  Serial.print(" FAILED_SECTORS=");
  Serial.println(failedSectors);
}

// Full Ultralight/NTAG page dump. MIFARE_Read returns 4 pages per call; we emit
// one line per single page. Page count is derived by reading until error, with
// a hard cap of 231 (NTAG216 has 231 user+config pages).
static void cloneReadUltralight() {
  Serial.print("OK ULDUMP_BEGIN UID=");
  Serial.print(currentUidHex());
  Serial.print(" SIZE=");
  Serial.print(rfid.uid.size);
  Serial.print(" TYPE=");
  Serial.print(currentTypeToken());

  // First pass: determine page count by probing 4-page reads until failure.
  const byte PAGE_CAP = 231;
  byte pageCount = 0;
  for (byte p = 0; p < PAGE_CAP; p += 4) {
    byte buf[18]; byte sz = sizeof(buf);
    if (rfid.MIFARE_Read(p, buf, &sz) != MFRC522::STATUS_OK) break;
    byte got = 4;
    if ((int)p + 4 > (int)PAGE_CAP) got = PAGE_CAP - p;
    pageCount = p + got;
  }
  if (pageCount == 0) pageCount = 16;  // conservative floor if probing failed
  Serial.print(" PAGES=");
  Serial.println(pageCount);

  byte okPages = 0, failedPages = 0;
  for (byte p = 0; p < pageCount; p++) {
    byte buf[18]; byte sz = sizeof(buf);
    // Read 4 pages at p but emit only this single page's 4 bytes.
    MFRC522::StatusCode st = rfid.MIFARE_Read(p, buf, &sz);
    Serial.print("PAGE=");
    Serial.print(p);
    if (st == MFRC522::STATUS_OK) {
      Serial.print(" DATA=");
      Serial.println(bytesToHex(buf, 4, false));
      okPages++;
    } else {
      Serial.print(" ERR=");
      Serial.println(statusName(st));
      failedPages++;
    }
  }
  rfid.PICC_HaltA();
  Serial.print("OK ULDUMP_END OK_PAGES=");
  Serial.print(okPages);
  Serial.print(" FAILED_PAGES=");
  Serial.println(failedPages);
}

static void commandCloneRead() {
  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }
  CardFamily fam = currentCardFamily();
  if (fam == CardFamily::CLASSIC) {
    cloneReadClassic();
  } else if (fam == CardFamily::ULTRALIGHT) {
    cloneReadUltralight();
  } else {
    Serial.print("ERR CLONE_UNSUPPORTED TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
  }
}

static void commandCloneReadUl() {
  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }
  CardFamily fam = currentCardFamily();
  if (fam != CardFamily::ULTRALIGHT) {
    Serial.print("ERR CLONE_UNSUPPORTED TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
    return;
  }
  cloneReadUltralight();
}

// SAFE magic detection. Determines Gen1a (backdoor) / Gen2 (direct block0 write)
// for Classic, or magic Ultralight (rewriting pages 0-2 unchanged). Never alters
// data: Gen2 and UL detection write existing bytes back unchanged.
static void commandMagicDetect() {
  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }
  CardFamily fam = currentCardFamily();

  if (fam == CardFamily::CLASSIC) {
    // Try the Gen1a backdoor first; it is non-destructive (just opens access).
    if (magicOpenGen1a()) {
      rfid.PICC_HaltA();
      byte uidlen = (rfid.uid.size == 7) ? 7 : 4;
      Serial.print("OK MAGIC TYPE=CLASSIC GEN=GEN1A UIDLEN=");
      Serial.print(uidlen);
      Serial.println(" METHOD=BACKDOOR");
      return;
    }
    // Re-select after the backdoor probe before trying Gen2.
    selectCard();
    if (detectGen2Writable()) {
      rfid.PICC_HaltA();
      byte uidlen = (rfid.uid.size == 7) ? 7 : 4;
      Serial.print("OK MAGIC TYPE=CLASSIC GEN=GEN2 UIDLEN=");
      Serial.print(uidlen);
      Serial.println(" METHOD=DIRECT");
      return;
    }
    rfid.PICC_HaltA();
    byte uidlen = (rfid.uid.size == 7) ? 7 : 4;
    Serial.print("OK MAGIC TYPE=CLASSIC GEN=NORMAL UIDLEN=");
    Serial.print(uidlen);
    Serial.println(" METHOD=NONE");
    return;
  }

  if (fam == CardFamily::ULTRALIGHT) {
    // Magic UL test: rewrite pages 0-2 with their EXISTING bytes (unchanged).
    bool magic = true;
    for (byte p = 0; p <= 2 && magic; p++) {
      byte buf[18]; byte sz = sizeof(buf);
      if (rfid.MIFARE_Read(p, buf, &sz) != MFRC522::STATUS_OK) { magic = false; break; }
      byte same[4]; memcpy(same, buf, 4);
      if (rfid.MIFARE_Ultralight_Write(p, same, 4) != MFRC522::STATUS_OK) magic = false;
    }
    rfid.PICC_HaltA();
    if (magic) {
      Serial.println("OK MAGIC TYPE=ULTRALIGHT GEN=MAGIC METHOD=DIRECT");
    } else {
      Serial.println("OK MAGIC TYPE=ULTRALIGHT GEN=NORMAL METHOD=NONE");
    }
    return;
  }

  Serial.print("ERR MAGIC_UNSUPPORTED TYPE=");
  Serial.println(currentTypeToken());
  rfid.PICC_HaltA();
}

static void commandCloneUid(const String& block0Hex, const String& method) {
  byte block0[16];
  if (!hexToBytes(block0Hex, block0, 16)) {
    Serial.println("ERR BAD_DATA expected 32 hex chars");
    return;
  }
  // BCC check for 4-byte UID: byte[4] must equal uid0^uid1^uid2^uid3.
  byte expectedBcc = bccClassic(block0);
  if (block0[4] != expectedBcc) {
    Serial.print("ERR CLONE_UID_BAD_BCC EXPECTED=0x");
    printHex2(expectedBcc);
    Serial.print(" GOT=0x");
    printHex2(block0[4]);
    Serial.println();
    return;
  }

  String m = method;
  m.toUpperCase();

  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }
  if (currentCardFamily() != CardFamily::CLASSIC) {
    Serial.print("ERR CLONE_UNSUPPORTED TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
    return;
  }

  // AUTO: pick a method via the same logic as MAGIC_DETECT.
  if (m == "AUTO") {
    if (magicOpenGen1a()) {
      m = "GEN1A";
      // backdoor is already open; fall through to GEN1A path which re-opens.
      rfid.PICC_HaltA();
      selectCard();
    } else {
      selectCard();
      m = detectGen2Writable() ? "GEN2" : "NORMAL";
      selectCard();
    }
  }

  // M3: the BCC check above and the block-0 write assume a 4-byte UID. The
  // GEN1A path refuses 7-byte UIDs with its own message; guard the GEN2/DIRECT
  // path here too. A 7-byte UID block 0 has a different layout (cascade byte +
  // two partial BCCs) that we do not support, so reject before any write.
  if ((m == "GEN2" || m == "DIRECT") && rfid.uid.size != 4) {
    Serial.println("ERR CLONE_UID_7BYTE_NOT_SUPPORTED");
    rfid.PICC_HaltA();
    return;
  }

  if (m == "NORMAL") {
    Serial.println("ERR CLONE_UID_NORMAL_CARD");
    rfid.PICC_HaltA();
    return;
  }

  if (m == "GEN1A") {
    // Gen1a magic supports 4-byte UID block0 only.
    if (rfid.uid.size == 7) {
      Serial.println("ERR CLONE_UID_GEN1A_4BYTE_ONLY");
      rfid.PICC_HaltA();
      return;
    }
    if (!magicOpenGen1a()) {
      Serial.println("ERR CLONE_UID_NORMAL_CARD");
      rfid.PICC_HaltA();
      return;
    }
    MFRC522::StatusCode st = rfid.MIFARE_Write(0, block0, 16);
    rfid.PICC_HaltA();
    if (st != MFRC522::STATUS_OK) {
      Serial.print("ERR CLONE_UID ");
      Serial.println(statusName(st));
      return;
    }
    Serial.print("OK CLONE_UID METHOD=GEN1A UID=");
    Serial.println(bytesToHex(block0, 4, false));
    return;
  }

  if (m == "GEN2" || m == "DIRECT") {
    String kh; char kt;
    if (!authSectorWithDict(0, kh, kt)) {
      Serial.println("ERR CLONE_UID_NORMAL_CARD");
      rfid.PCD_StopCrypto1();
      rfid.PICC_HaltA();
      return;
    }
    MFRC522::StatusCode st = rfid.MIFARE_Write(0, block0, 16);
    rfid.PCD_StopCrypto1();
    rfid.PICC_HaltA();
    if (st != MFRC522::STATUS_OK) {
      Serial.print("ERR CLONE_UID ");
      Serial.println(statusName(st));
      return;
    }
    Serial.print("OK CLONE_UID METHOD=GEN2 UID=");
    Serial.println(bytesToHex(block0, 4, false));
    return;
  }

  Serial.println("ERR USAGE CLONE_UID <block0hex32> METHOD=<GEN1A|GEN2|AUTO>");
  rfid.PICC_HaltA();
}

// WRITE_BLOCK_RAW: dictionary/provided-key auth then write a data block.
// Refuses block 0 and sector trailers (same safety as WRITE_BLOCK).
static void commandWriteBlockRaw(byte block, const String& dataHex, const String& keyHex) {
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
  if (currentCardFamily() != CardFamily::CLASSIC) {
    Serial.print("ERR UNSUPPORTED_CARD TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
    return;
  }

  if (!authenticateBlock(block, keyHex)) {
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }
  MFRC522::StatusCode st = rfid.MIFARE_Write(block, data, 16);
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  if (st != MFRC522::STATUS_OK) {
    Serial.print("ERR WRITE ");
    Serial.println(statusName(st));
    return;
  }
  // Reuse the WRITE_BLOCK success framing for web-parser reuse.
  Serial.print("OK WROTE BLOCK=");
  Serial.print(block);
  Serial.print(" DATA=");
  Serial.println(bytesToHex(data, 16, false));
}

// Validate the 3-byte access-bits field (trailer bytes 6,7,8) for internal
// self-consistency: byte7 high nibble must be the inverse of byte6 low nibble,
// and the standard inversion relationships must hold. Returns true if valid.
static bool accessBitsSelfConsistent(const byte* t) {
  byte b6 = t[6], b7 = t[7], b8 = t[8];
  // Extract the inverted (c?_) and true (c?) nibbles per MIFARE trailer layout.
  byte c1_  = (b7 >> 4) & 0x0F;
  byte c1   = (b8 >> 4) & 0x0F;
  byte c2_  = (b6) & 0x0F;
  byte c2   = (b8) & 0x0F;
  byte c3_  = (b6 >> 4) & 0x0F;
  byte c3   = (b7) & 0x0F;
  // The inverted nibbles must be the bitwise complement (low 4 bits) of the true.
  if (((c1 ^ c1_) & 0x0F) != 0x0F) return false;
  if (((c2 ^ c2_) & 0x0F) != 0x0F) return false;
  if (((c3 ^ c3_) & 0x0F) != 0x0F) return false;
  return true;
}

// WRITE_TRAILER: write a 16-byte sector trailer. Validates trailer position and
// access-bit self-consistency. Warns if the incoming Key A region is all zero.
static void commandWriteTrailer(byte block, const String& dataHex, const String& keyHex) {
  if (!isSectorTrailer(block)) {
    Serial.println("ERR NOT_A_TRAILER");
    return;
  }
  byte data[16];
  if (!hexToBytes(dataHex, data, 16)) {
    Serial.println("ERR BAD_DATA expected 32 hex chars");
    return;
  }
  if (!accessBitsSelfConsistent(data)) {
    Serial.println("ERR TRAILER_BAD_ACCESS_BITS");
    return;
  }
  bool zeroKeyA = (data[0] | data[1] | data[2] | data[3] | data[4] | data[5]) == 0;

  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }
  if (currentCardFamily() != CardFamily::CLASSIC) {
    Serial.print("ERR UNSUPPORTED_CARD TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
    return;
  }
  if (!authenticateBlock(block, keyHex)) {
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }
  MFRC522::StatusCode st = rfid.MIFARE_Write(block, data, 16);
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  if (st != MFRC522::STATUS_OK) {
    Serial.print("ERR WRITE ");
    Serial.println(statusName(st));
    return;
  }
  Serial.print("OK WROTE_TRAILER BLOCK=");
  Serial.print(block);
  if (zeroKeyA) Serial.print(" WARN=ZERO_KEYA");
  Serial.println();
}

// WRITE_PAGE_RAW: magic-NTAG raw page write. Allows pages 0-2 (for magic UID
// rewrite), refuses page 3 (OTP) and a cascade-tag byte at page1[0]==0x88.
static void commandWritePageRaw(byte page, const String& dataHex) {
  byte data[4];
  if (!hexToBytes(dataHex, data, 4)) {
    Serial.println("ERR BAD_DATA expected 8 hex chars");
    return;
  }
  if (page == 3) {
    Serial.println("ERR REFUSE_PAGE_OTP");
    return;
  }
  if (page == 1 && data[0] == 0x88) {
    Serial.println("ERR REFUSE_UL_CASCADE_BYTE");
    return;
  }

  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }
  if (currentCardFamily() != CardFamily::ULTRALIGHT) {
    Serial.print("ERR UNSUPPORTED_CARD TYPE=");
    Serial.println(currentTypeToken());
    rfid.PICC_HaltA();
    return;
  }
  MFRC522::StatusCode st = rfid.MIFARE_Ultralight_Write(page, data, 4);
  rfid.PICC_HaltA();
  if (st != MFRC522::STATUS_OK) {
    Serial.print("ERR WRITE ");
    Serial.println(statusName(st));
    return;
  }
  Serial.print("OK WROTE_PAGE PAGE=");
  Serial.print(page);
  Serial.print(" DATA=");
  Serial.println(bytesToHex(data, 4, false));
}

// ATS: request Answer To Select for ISO-14443-4 cards.
static void commandAts() {
  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }
  if (currentCardFamily() != CardFamily::ISO4) {
    Serial.println("ERR WRONG_CARD_TYPE");
    rfid.PICC_HaltA();
    return;
  }
  MFRC522Extended::Ats ats;
  if (rfid.PICC_RequestATS(&ats) != MFRC522::STATUS_OK || ats.size == 0) {
    Serial.println("ERR NO_ATS");
    rfid.PICC_HaltA();
    return;
  }
  Serial.print("OK ATS=");
  Serial.print(bytesToHex(ats.data, ats.size, false));
  // Historical bytes follow the format byte (T0) and any TA/TB/TC interface
  // bytes. Compute their offset from the interface-byte presence flags.
  byte off = 2;  // skip TL (data[0]) and T0 (data[1])
  if (ats.ta1.transmitted) off++;
  if (ats.tb1.transmitted) off++;
  if (ats.tc1.transmitted) off++;
  Serial.print(" HISTBYTES=");
  if (ats.size > off) {
    Serial.println(bytesToHex(ats.data + off, ats.size - off, false));
  } else {
    Serial.println("-");
  }
}

// APDU: single ISO-14443-4 T=CL exchange.
static void commandApdu(const String& capduHex) {
  String hx = capduHex;
  hx.trim();
  hx.replace(" ", "");
  if ((hx.length() % 2) != 0 || hx.length() == 0) {
    Serial.println("ERR BAD_DATA expected even-length hex");
    return;
  }
  byte reqLen = hx.length() / 2;
  if (reqLen > 60) {
    Serial.println("ERR APDU_TOO_LONG");
    return;
  }
  byte req[60];
  if (!hexToBytes(hx, req, reqLen)) {
    Serial.println("ERR BAD_DATA expected even-length hex");
    return;
  }

  if (!selectCard()) {
    Serial.println("ERR NO_CARD");
    return;
  }
  if (currentCardFamily() != CardFamily::ISO4) {
    Serial.println("ERR WRONG_CARD_TYPE");
    rfid.PICC_HaltA();
    return;
  }
  // Activate T=CL: request ATS into the member tag struct used by TCL_Transceive.
  if (rfid.PICC_RequestATS(&rfid.tag.ats) != MFRC522::STATUS_OK) {
    Serial.println("ERR NO_ATS");
    rfid.PICC_HaltA();
    return;
  }

  byte resp[64];
  byte respLen = sizeof(resp);
  MFRC522::StatusCode st = rfid.TCL_Transceive(&rfid.tag, req, reqLen, resp, &respLen);
  if (st != MFRC522::STATUS_OK) {
    Serial.print("ERR APDU ");
    Serial.println(statusName(st));
    rfid.PICC_HaltA();
    return;
  }
  if (respLen > 60) {
    Serial.println("ERR APDU_TOO_LONG");
    rfid.PICC_HaltA();
    return;
  }

  Serial.print("OK APDU RESP=");
  if (respLen > 0) Serial.print(bytesToHex(resp, respLen, false));
  // The trailing two bytes (if present) are the ISO-7816 status word SW1 SW2.
  Serial.print(" SW=");
  if (respLen >= 2) {
    Serial.println(bytesToHex(resp + (respLen - 2), 2, false));
  } else {
    Serial.println("-");
  }
  rfid.PICC_HaltA();
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

// Returns the value of a "PREFIX=value" token. Prefix match is case-insensitive
// on the key; if the token does not start with the prefix, returns "".
static String stripPrefix(const String& token, const char* prefix) {
  String up = token;
  up.toUpperCase();
  String p = String(prefix);
  p.toUpperCase();
  if (up.startsWith(p)) {
    return token.substring(strlen(prefix));
  }
  return "";
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
  } else if (cmd == "RESCAN") {
    String msStr = nextToken(rest);
    if (msStr.length() == 0) {
      // Query current interval.
      Serial.print("OK RESCAN ");
      Serial.println(rescanIntervalMs);
    } else {
      long ms = msStr.toInt();
      if (ms < 0) {
        Serial.println("ERR BAD_INTERVAL");
        return;
      }
      rescanIntervalMs = (unsigned long)ms;
      Serial.print("OK RESCAN ");
      Serial.println(rescanIntervalMs);
    }
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
  } else if (cmd == "READ_PAGE") {
    String pageStr = nextToken(rest);
    if (pageStr.length() == 0) {
      Serial.println("ERR USAGE READ_PAGE <page>");
      return;
    }
    int page = pageStr.toInt();
    if (page < 0 || page > 255) {
      Serial.println("ERR BAD_PAGE");
      return;
    }
    commandReadPage((byte)page);
  } else if (cmd == "WRITE_PAGE") {
    String pageStr = nextToken(rest);
    String dataHex = nextToken(rest);
    if (pageStr.length() == 0 || dataHex.length() == 0) {
      Serial.println("ERR USAGE WRITE_PAGE <page> <hex8>");
      return;
    }
    int page = pageStr.toInt();
    if (page < 0 || page > 255) {
      Serial.println("ERR BAD_PAGE");
      return;
    }
    commandWritePage((byte)page, dataHex);
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
  } else if (cmd == "CLONE_READ") {
    commandCloneRead();
  } else if (cmd == "CLONE_READ_UL") {
    commandCloneReadUl();
  } else if (cmd == "MAGIC_DETECT") {
    commandMagicDetect();
  } else if (cmd == "CLONE_UID") {
    String block0Hex = nextToken(rest);
    String methodTok = nextToken(rest);   // expected "METHOD=<...>"
    String method = stripPrefix(methodTok, "METHOD=");
    if (block0Hex.length() == 0 || method.length() == 0) {
      Serial.println("ERR USAGE CLONE_UID <block0hex32> METHOD=<GEN1A|GEN2|AUTO>");
      return;
    }
    commandCloneUid(block0Hex, method);
  } else if (cmd == "WRITE_BLOCK_RAW") {
    String blockStr = nextToken(rest);
    String dataHex = nextToken(rest);
    String keyTok = nextToken(rest);       // expected "KEY=<hex12>"
    String keyHex = stripPrefix(keyTok, "KEY=");
    if (blockStr.length() == 0 || dataHex.length() == 0 || keyHex.length() == 0) {
      Serial.println("ERR USAGE WRITE_BLOCK_RAW <block> <hex32> KEY=<hex12>");
      return;
    }
    int block = blockStr.toInt();
    if (block < 0 || block > 255) {
      Serial.println("ERR BAD_BLOCK");
      return;
    }
    commandWriteBlockRaw((byte)block, dataHex, keyHex);
  } else if (cmd == "WRITE_TRAILER") {
    String blockStr = nextToken(rest);
    String dataHex = nextToken(rest);
    String keyTok = nextToken(rest);
    String keyHex = stripPrefix(keyTok, "KEY=");
    if (blockStr.length() == 0 || dataHex.length() == 0 || keyHex.length() == 0) {
      Serial.println("ERR USAGE WRITE_TRAILER <trailerBlock> <hex32> KEY=<hex12>");
      return;
    }
    int block = blockStr.toInt();
    if (block < 0 || block > 255) {
      Serial.println("ERR BAD_BLOCK");
      return;
    }
    commandWriteTrailer((byte)block, dataHex, keyHex);
  } else if (cmd == "WRITE_PAGE_RAW") {
    String pageStr = nextToken(rest);
    String dataHex = nextToken(rest);
    if (pageStr.length() == 0 || dataHex.length() == 0) {
      Serial.println("ERR USAGE WRITE_PAGE_RAW <page> <hex8>");
      return;
    }
    int page = pageStr.toInt();
    if (page < 0 || page > 255) {
      Serial.println("ERR BAD_PAGE");
      return;
    }
    commandWritePageRaw((byte)page, dataHex);
  } else if (cmd == "ATS") {
    commandAts();
  } else if (cmd == "APDU") {
    String capdu = nextToken(rest);
    if (capdu.length() == 0) {
      Serial.println("ERR USAGE APDU <hexCAPDU>");
      return;
    }
    commandApdu(capdu);
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
    unsigned long nowMs = millis();
    bool isNewInsertion = (!cardPresent || uid != lastUid);
    // Periodic re-scan: same card still present and the rescan interval elapsed.
    bool isRescanReemit = (!isNewInsertion && rescanIntervalMs > 0 &&
                           (nowMs - lastEmitMs >= rescanIntervalMs));
    if (isNewInsertion || isRescanReemit) {
      cardPresent = true;
      lastUid = uid;
      lastEmitMs = nowMs;
      Serial.print("EVENT CARD_PRESENT UID=");
      Serial.println(uid);
    }
    // Local LED indicator (debounced). A card was read this poll, so it is
    // present: clear the absent counter and, on the rising edge of the debounced
    // presence, drive the LED straight to SOLID ON via onCardIntake(). NOTE:
    // this is gated on !ledPresent, so a RESCAN periodic re-emit (same card
    // still present) does NOT re-fire the intake hook -- the LED just stays
    // solid ON. Does not alter serial output.
    ledAbsentCount = 0;
    if (!ledPresent) {
      ledPresent = true;
      ledOnCardState(true);
    }
    rfid.PICC_HaltA();
    stopCardCrypto();
  } else {
    // Very lightweight absence detection. It won't be perfect, but it avoids spamming.
    // Manual SCAN remains authoritative.
    // Local LED indicator (debounced): a single absent poll is NOT enough to
    // declare the card gone, because the card is halted after each read and so
    // is not reported as "new" every poll. Only after LED_ABSENT_DEBOUNCE
    // consecutive absent polls do we treat the card as genuinely removed: turn
    // the LED off AND clear the `cardPresent` latch. Clearing cardPresent gives
    // the firmware a real "card gone" edge so that (a) a re-presented card
    // counts as a NEW insertion (fresh EVENT CARD_PRESENT + LED intake), and
    // (b) RESCAN only re-emits while the SAME card is *continuously* present.
    // With rescanIntervalMs==0 this does not change the observable behavior:
    // emission is still exactly once per physical insertion.
    if (ledPresent) {
      if (ledAbsentCount < LED_ABSENT_DEBOUNCE) ledAbsentCount++;
      if (ledAbsentCount >= LED_ABSENT_DEBOUNCE) {
        ledPresent = false;
        cardPresent = false;   // genuine "card gone" edge (debounce satisfied)
        ledOnCardState(false);
      }
    }
  }
}

void setup() {
  pinMode(PIN_RFID_IRQ, INPUT_PULLUP);

  // Onboard LED (GPIO 25 on a plain Pico) used as a local card-detect indicator.
  pinMode(LED_BUILTIN, OUTPUT);
  ledWrite(false);
  // Mark the flash overlay as already expired so no spurious flash fires before
  // the first SCAN (millis() starts near 0, so leave a full window behind us).
  ledFlashStartMs = millis() - LED_FLASH_MS;

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
  ledUpdate();  // non-blocking: applies SCAN flash overlay or resting state
  delay(2);
}
