# RP2040 RFID Web Serial Tester

This zip contains a quick first-pass RFID reader/writer test setup:

- `firmware-arduino-pico/` - RP2040/Pico firmware using Arduino-Pico + MFRC522.
- `web/index.html` - Static browser UI using the Web Serial API.
- `docs/WIRING.md` - Pico to RC522 wiring.

The primary firmware is Arduino-Pico rather than nanoFramework because the browser-based Web Serial control path needs a plain USB serial stream. nanoFramework is still a good follow-up for the framework layer, but for a quick browser-controlled RFID reader/writer, Arduino-Pico is the lower-friction first test.

## Hardware

- Raspberry Pi Pico / RP2040 dev board
- RC522 / MFRC522 RFID module
- 13.56 MHz MIFARE Classic-style test card or fob
- Jumper wires

See `docs/WIRING.md` for the full wiring table.

## Firmware build with PlatformIO

From `firmware-arduino-pico/`:

```powershell
pio run
pio run -t upload
pio device monitor -b 115200
```

If upload does not auto-detect the Pico, hold `BOOTSEL`, plug the Pico in, then upload again.

## Firmware build with Arduino IDE

1. Install the Earle Philhower Raspberry Pi Pico Arduino core.
2. Install the `MFRC522` library by Miguel Balboa.
3. Create a new sketch.
4. Copy the contents of `firmware-arduino-pico/src/main.cpp` into the sketch.
5. Select your Pico/RP2040 board.
6. Upload.

## Web UI

Web Serial requires Chrome or Edge desktop and a secure origin (localhost or HTTPS).

The web UI is a Vite + TypeScript app. From the `web/` directory:

```powershell
cd web
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome or Edge and click **Connect**.

**Hardware-free demo mode** — append `?mock=1` to the URL to use a built-in mock Pico (no hardware required):

```text
http://localhost:5173/?mock=1
```

The deployed Pages site also supports demo mode:

```text
https://jerrettdavis.github.io/PiPicoRFIDExperiments/?mock=1
```

Once connected (real or mock), try:

- `Ping`
- `Version`
- `Scan UID`
- `Read Block`
- `Dump Sector`

### Running e2e tests

```powershell
cd web
npm run test:e2e
```

## Serial protocol

Commands are newline-terminated ASCII.

```text
PING
VERSION
HELP
RESCAN [ms]
SCAN
READ_BLOCK <block> [keyAhex12]
WRITE_BLOCK <block> <hex32> [keyAhex12]
DUMP <startBlock> <endBlock> [keyAhex12]
READ_PAGE <page>
WRITE_PAGE <page> <hex8>
CLONE_READ
CLONE_READ_UL
MAGIC_DETECT
CLONE_UID <block0hex32> METHOD=<GEN1A|GEN2|AUTO>
WRITE_BLOCK_RAW <block> <hex32> KEY=<hex12>
WRITE_TRAILER <trailerBlock> <hex32> KEY=<hex12>
WRITE_PAGE_RAW <page> <hex8>
ATS
APDU <hexCAPDU>
```

### RESCAN — periodic re-emission

`RESCAN <ms>` sets a re-scan interval and replies `OK RESCAN <ms>`. `RESCAN` with no argument queries the current value and replies `OK RESCAN <current_ms>`. The default on boot is `0` (disabled).

When `ms > 0`, the firmware re-emits `EVENT CARD_PRESENT UID=<uid>` every `<ms>` milliseconds for as long as the **same** card stays continuously present, letting the host periodically re-read it. When `ms = 0` the behavior is the original one: `EVENT CARD_PRESENT` is emitted once per physical insertion. The onboard LED only runs its blink burst on a genuinely new insertion — periodic re-emits keep the LED solid-on without re-blinking.

### Card-type awareness

`SCAN` (aliases `UID`, `READ_UID`) reports a normalized, machine-parseable line:

```text
OK UID=<hex> SIZE=<4|7|10> SAK=0x<NN> TYPE=<TOKEN> ATQA=0x<NNNN> [ATS=<hex>]
```

`TYPE` is one of: `MIFARE_MINI`, `MIFARE_1K`, `MIFARE_4K`, `MIFARE_UL`, `MIFARE_PLUS`, `ISO_14443_4`, `ISO_18092`, `UNKNOWN`. `ATQA` is always present (the 2-byte answer-to-request, little-endian as captured). `ATS=<hex>` is appended only for ISO-14443-4 cards when a RATS request succeeds. (`EVENT CARD_PRESENT UID=<hex>` is unchanged.)

Block/page commands dispatch on the detected card family **before** any authentication:

| Command | MIFARE Classic | Ultralight / NTAG | ISO-14443-4 / unknown |
|---------|----------------|-------------------|------------------------|
| `READ_BLOCK` / `DUMP` | Key-A read | `ERR WRONG_CARD_TYPE USE=READ_PAGE` | `ERR UNSUPPORTED_CARD TYPE=<TOKEN>` |
| `WRITE_BLOCK` | Key-A write | `ERR WRONG_CARD_TYPE USE=WRITE_PAGE` | `ERR UNSUPPORTED_CARD TYPE=<TOKEN>` |
| `READ_PAGE` | `ERR WRONG_CARD_TYPE USE=READ_BLOCK` | no-auth read, 16 bytes | `ERR UNSUPPORTED_CARD TYPE=<TOKEN>` |
| `WRITE_PAGE` | `ERR WRONG_CARD_TYPE USE=WRITE_BLOCK` | no-auth write, 4 bytes | `ERR UNSUPPORTED_CARD TYPE=<TOKEN>` |

ISO-14443-4 cards (e.g. SAK `0x20`) are now rejected cleanly instead of returning a confusing `ERR AUTH Timeout`. If no card is on the antenna, all of these reply `ERR NO_CARD`.

### MIFARE Classic blocks (READ_BLOCK / WRITE_BLOCK / DUMP)

Default MIFARE Classic Key A is:

```text
FFFFFFFFFFFF
```

The firmware refuses writes to block `0` and sector trailer blocks. That is intentional. Accidentally overwriting a sector trailer can lock you out of the sector. Accidentally overwriting block 0 can damage UID/manufacturer data on writable-clone cards. Trailer detection is geometry-aware: on 1K/Mini cards trailers are blocks `3`, `7`, `11`, ... ; on 4K cards the large sectors 32–39 (blocks 128–255) are 16 blocks each, so their trailers are at `sectorStart + 15` (e.g. block `143`, `159`, ...). Valid block range is `0`–`255`.

### Ultralight / NTAG pages (READ_PAGE / WRITE_PAGE)

These target MIFARE Ultralight and NTAG21x tags and use **no authentication**.

- `READ_PAGE <page>` → `OK PAGE=<n> DATA=<32hex>` (a single read returns 16 bytes = 4 pages, starting at `<page>`). On failure: `ERR READ <status>`.
- `WRITE_PAGE <page> <hex8>` writes exactly 4 bytes (8 hex chars) → `OK WROTE_PAGE PAGE=<n> DATA=<8hex>`. Pages `0`–`3` (UID / lock bytes / OTP) are refused with `ERR REFUSE_PAGE`. Bad hex length replies `ERR BAD_DATA`.

## Cloning primitives (v0.3)

These commands support inspecting and (for *magic* cards) duplicating tags. They use the `MFRC522Extended` driver, a built-in MIFARE Classic key dictionary, and the inherited magic-UID helpers.

### CLONE_READ — full read of the present card

Auto-dispatches by card family.

**MIFARE Classic** streams a framed dump that tries the key dictionary (Key A then Key B) per sector:

```text
OK CLONE_BEGIN UID=<hex> SIZE=<n> SAK=0x<NN> TYPE=<TOKEN> SECTORS=<n>
SECTOR=<s> KEY=<hex12|------------> KEYTYPE=<A|B|NONE> STATUS=<OK|FAILED>
BLOCK=<b> DATA=<hex32>        # one line per readable block (or BLOCK=<b> ERR=<reason>)
...
OK CLONE_END OK_SECTORS=<n> FAILED_SECTORS=<n>
```

A sector whose key is not in the dictionary emits its `SECTOR=` line with `KEY=------------ KEYTYPE=NONE STATUS=FAILED` and **no** block lines. Trailer blocks are included (the Key A region reads back as zeros — expected). **Ultralight/NTAG** cards are dispatched to the `CLONE_READ_UL` framing below. **ISO-14443-4 / unknown** → `ERR CLONE_UNSUPPORTED TYPE=<TOKEN>`.

### CLONE_READ_UL — full Ultralight/NTAG page dump

```text
OK ULDUMP_BEGIN UID=<hex> SIZE=<n> TYPE=<TOKEN> PAGES=<n>
PAGE=<p> DATA=<hex8>          # one line per single page (or PAGE=<p> ERR=<reason>)
...
OK ULDUMP_END OK_PAGES=<n> FAILED_PAGES=<n>
```

Page count is discovered by reading until error (hard cap 231 for NTAG216).

### MAGIC_DETECT — safe magic-card probe

Never alters data (Gen2 / Ultralight tests write existing bytes back unchanged).

- Classic → `OK MAGIC TYPE=CLASSIC GEN=<GEN1A|GEN2|NORMAL> UIDLEN=<4|7> METHOD=<BACKDOOR|DIRECT|NONE>`
- Ultralight → `OK MAGIC TYPE=ULTRALIGHT GEN=<MAGIC|NORMAL> METHOD=<DIRECT|NONE>`
- ISO-14443-4 → `ERR MAGIC_UNSUPPORTED TYPE=<TOKEN>`

### CLONE_UID — write a new UID block (magic cards only)

`CLONE_UID <block0hex32> METHOD=<GEN1A|GEN2|AUTO>`. The 32 hex chars are the full 16-byte block 0; the firmware validates the 4-byte BCC (`block0[4] == uid0^uid1^uid2^uid3`):

- BCC mismatch → `ERR CLONE_UID_BAD_BCC EXPECTED=0x<NN> GOT=0x<NN>`
- `GEN1A`: opens the Gen1a backdoor and writes block 0 (4-byte UID only; a 7-byte UID → `ERR CLONE_UID_GEN1A_4BYTE_ONLY`)
- `GEN2`/`DIRECT`: dictionary-auths sector 0 and writes block 0 directly
- `AUTO`: runs the `MAGIC_DETECT` logic and picks the method
- Success → `OK CLONE_UID METHOD=<GEN1A|GEN2> UID=<newUidHex>`
- A normal (non-magic) card → `ERR CLONE_UID_NORMAL_CARD`; other failures → `ERR CLONE_UID <statusName>`

### WRITE_BLOCK_RAW / WRITE_TRAILER (Classic, explicit key)

- `WRITE_BLOCK_RAW <block> <hex32> KEY=<hex12>` authenticates with the provided key and writes a data block. Block `0` → `ERR REFUSE_BLOCK_ZERO`; trailers → `ERR REFUSE_SECTOR_TRAILER`. Success → `OK WROTE BLOCK=<b> DATA=<hex32>` (same framing as `WRITE_BLOCK`).
- `WRITE_TRAILER <trailerBlock> <hex32> KEY=<hex12>` writes a sector trailer. Non-trailer → `ERR NOT_A_TRAILER`; self-inconsistent access bits (bytes 6–8) → `ERR TRAILER_BAD_ACCESS_BITS`. Success → `OK WROTE_TRAILER BLOCK=<b>`, with ` WARN=ZERO_KEYA` appended if the incoming Key A region is all-zero.

### WRITE_PAGE_RAW (magic NTAG)

`WRITE_PAGE_RAW <page> <hex8>` allows pages `0`–`2` (for magic-UID rewrites) but refuses page `3` (`ERR REFUSE_PAGE_OTP`) and a cascade tag at page 1 byte 0 = `0x88` (`ERR REFUSE_UL_CASCADE_BYTE`). Success → `OK WROTE_PAGE PAGE=<p> DATA=<hex8>`. (The safe `WRITE_PAGE` command, which refuses pages 0–3, is unchanged.)

### ATS / APDU (ISO-14443-4)

- `ATS` → `OK ATS=<hex> HISTBYTES=<hex|->` (or `ERR NO_ATS` / `ERR WRONG_CARD_TYPE`).
- `APDU <hexCAPDU>` performs a single T=CL exchange → `OK APDU RESP=<hex> SW=<hex4|->`. Requests or responses over 60 bytes → `ERR APDU_TOO_LONG`; transport failure → `ERR APDU <statusName>`.

### Honest limits

- **DESFire, EMV payment cards, transit cards, and phones cannot be cloned** by this firmware — they use cryptographic authentication this tool does not implement.
- **Sectors whose keys are not in the dictionary are unreadable** — `CLONE_READ` marks them `STATUS=FAILED` and emits no block data.
- **A normal (non-magic) card's UID cannot be changed.** Block 0 is read-only on standard cards; only Gen1a/Gen2 "magic" cards accept a new UID.
- **Gen1a magic is 4-byte-UID only.** Writing a 7-byte UID requires a Gen2 (direct-write) magic card.
- Cloning copies data only — it does not defeat any access control that relies on cryptographic challenge/response.

## Useful test block

For a normal MIFARE Classic 1K card, start with block `4`.

Example write payload:

```text
48656C6C6F2066726F6D205069636F21
```

That is ASCII for:

```text
Hello from Pico!
```

## Notes and caveats

- RC522 is a 3.3V device. Do not use 5V power or 5V GPIO.
- The IRQ wire is included in the wiring, but this quick firmware uses polling for reliable first bring-up.
- RFID read/write support depends heavily on card type. The write/read block commands target MIFARE Classic-like cards with default keys.
- Many hotel badges, transit cards, payment cards, phones, and modern access cards will not be writable this way.
- Do not use this against systems or cards you do not own or have permission to test.

## nanoFramework follow-up plan

A nanoFramework version can use `nanoFramework.IoT.Device.Mfrc522` for the RFID driver. The main unresolved design decision is the command transport: browser Web Serial wants a plain USB CDC stream, while nanoFramework commonly uses the USB/COM path for deployment/debugging and UART APIs for hardware serial. The clean nanoFramework version may use a USB-to-UART adapter or a board/firmware target with an app-accessible serial endpoint.
