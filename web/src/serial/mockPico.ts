import type { SerialTransport, LineHandler, StatusHandler } from './transport.js';

const DEFAULT_KEY = 'FFFFFFFFFFFF';
const DICT_KEY = 'A0A1A2A3A4A5';
const VERSION_STR = '0x92';

export type MockCardKind =
  | 'classic'
  | 'classic-locked'
  | 'classic-gen1a'
  | 'classic-gen2'
  | 'ultralight'
  | 'ntag-magic'
  | 'iso4-desfire'
  // Backward-compatible alias for the v0.2 ISO4 card kind.
  | 'iso4';

type Family = 'CLASSIC' | 'ULTRALIGHT' | 'ISO4';

interface CardModel {
  uid: string;
  size: number;
  sak: string;
  type: string;
  family: Family;
  atqa: string;
  /** ISO4 only. */
  ats?: string;
  /** Classic magic: GEN1A|GEN2|NORMAL. UL magic: MAGIC|NORMAL. */
  magicGen: string;
  /** Classic: BACKDOOR|DIRECT|NONE. UL: DIRECT|NONE. */
  magicMethod: string;
  /** Classic UID length for MAGIC_DETECT. */
  uidLen?: number;
}

const CARDS: Record<MockCardKind, CardModel> = {
  'classic':        { uid: 'DEADBEEF',       size: 4, sak: '0x08', type: 'MIFARE_1K',   family: 'CLASSIC',    atqa: '0x0004', magicGen: 'NORMAL', magicMethod: 'NONE',     uidLen: 4 },
  'classic-locked': { uid: 'DEADBEEF',       size: 4, sak: '0x08', type: 'MIFARE_1K',   family: 'CLASSIC',    atqa: '0x0004', magicGen: 'NORMAL', magicMethod: 'NONE',     uidLen: 4 },
  'classic-gen1a':  { uid: 'CAFEF00D',       size: 4, sak: '0x08', type: 'MIFARE_1K',   family: 'CLASSIC',    atqa: '0x0004', magicGen: 'GEN1A',  magicMethod: 'BACKDOOR', uidLen: 4 },
  'classic-gen2':   { uid: 'BEEFCAFE',       size: 4, sak: '0x08', type: 'MIFARE_1K',   family: 'CLASSIC',    atqa: '0x0004', magicGen: 'GEN2',   magicMethod: 'DIRECT',   uidLen: 4 },
  'ultralight':     { uid: '04A1B2C3D4E5F6', size: 7, sak: '0x00', type: 'MIFARE_UL',   family: 'ULTRALIGHT', atqa: '0x0044', magicGen: 'NORMAL', magicMethod: 'NONE' },
  'ntag-magic':     { uid: '04112233445566', size: 7, sak: '0x00', type: 'MIFARE_UL',   family: 'ULTRALIGHT', atqa: '0x0044', magicGen: 'MAGIC',  magicMethod: 'DIRECT' },
  'iso4-desfire':   { uid: '04666BA27A1890', size: 7, sak: '0x20', type: 'ISO_14443_4', family: 'ISO4',       atqa: '0x0344', ats: '0675F7B102', magicGen: 'NORMAL', magicMethod: 'NONE' },
  // Alias kept so v0.2 tests referencing 'iso4' continue to work.
  'iso4':           { uid: '04666BA27A1890', size: 7, sak: '0x20', type: 'ISO_14443_4', family: 'ISO4',       atqa: '0x0344', ats: '0675F7B102', magicGen: 'NORMAL', magicMethod: 'NONE' },
};

const CLASSIC_SECTORS = 16; // 1K
const BLOCKS_PER_SECTOR = 4;

function isTrailerBlock(b: number): boolean {
  return b % BLOCKS_PER_SECTOR === BLOCKS_PER_SECTOR - 1;
}

class MockPico {
  /** Classic 1K data blocks. */
  private blocks: Map<number, string> = new Map();
  /** Ultralight pages (4 bytes / 8 hex each). */
  private pages: Map<number, string> = new Map();
  private current: MockCardKind = 'classic';
  private rescanMs = 0;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  /** Buzzer enabled state (default ON, matching firmware). */
  private buzzerOn = true;
  /** On-detect beep config (default 2700 Hz / 120 ms, matching firmware). */
  private beepFreq = 2700;
  private beepMs = 120;

  private emitLine: (line: string) => void;

  constructor(emitLine: (line: string) => void) {
    this.emitLine = emitLine;
    this.blocks.set(4, '48656C6C6F2066726F6D205069636F21');
    this.pages.set(4, '48656C6C');
  }

  setCard(kind: MockCardKind): void {
    this.current = kind;
  }

  private card(): CardModel {
    return CARDS[this.current];
  }

  private blockData(b: number): string {
    return this.blocks.get(b) ?? '00'.repeat(16);
  }

  private pageData(p: number): string {
    return this.pages.get(p) ?? '00'.repeat(4);
  }

  /** Sector key info for the current card — models locked sectors. */
  private sectorInfo(sector: number): { key: string; keyType: 'A' | 'B' | 'NONE'; status: 'OK' | 'FAILED' } {
    if (this.current === 'classic-locked') {
      // Sectors 5 & 9 use a non-dictionary key → FAILED. Some sectors use a dict key.
      if (sector === 5 || sector === 9) {
        return { key: '------------', keyType: 'NONE', status: 'FAILED' };
      }
      if (sector === 1 || sector === 2 || sector === 3) {
        return { key: DICT_KEY, keyType: 'A', status: 'OK' };
      }
    }
    return { key: DEFAULT_KEY, keyType: 'A', status: 'OK' };
  }

  private emit(line: string): void {
    setTimeout(() => {
      if (!this.destroyed) this.emitLine(line);
    }, 0);
  }

  start(): void {
    this.destroyed = false;
  }

  boot(): void {
    this.emit(`READY RP2040_RFID_USB 0.3.0`);
    this.emit(`PINS SS=17 SCK=18 MOSI=19 MISO=16 RST=20 IRQ=21`);
    this.emit(`EVENT CARD_PRESENT UID=${this.card().uid}`);
  }

  emitCardPresent(uid?: string): void {
    this.emit(`EVENT CARD_PRESENT UID=${uid ?? this.card().uid}`);
  }

  private startRescan(): void {
    this.stopRescan();
    if (this.rescanMs > 0) {
      this.rescanTimer = setInterval(() => {
        if (this.destroyed) return;
        this.emitLine(`EVENT CARD_PRESENT UID=${this.card().uid}`);
      }, this.rescanMs);
    }
  }

  private stopRescan(): void {
    if (this.rescanTimer !== null) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
  }

  reset(): void {
    this.destroyed = true;
    this.stopRescan();
    this.rescanMs = 0;
  }

  private scanLine(): string {
    const c = this.card();
    const atsPart = c.ats ? ` ATS=${c.ats}` : '';
    return `OK UID=${c.uid} SIZE=${c.size} SAK=${c.sak} TYPE=${c.type} ATQA=${c.atqa}${atsPart}`;
  }

  private block0(): string {
    // UID(4) + BCC + SAK + manufacturer pad → 32 hex
    const c = this.card();
    const uid = c.uid;
    if (uid.length === 8) {
      let bcc = 0;
      for (let i = 0; i < 8; i += 2) bcc ^= parseInt(uid.slice(i, i + 2), 16);
      const bccHex = bcc.toString(16).toUpperCase().padStart(2, '0');
      const sak = c.sak.replace('0x', '').padStart(2, '0').toUpperCase();
      return (uid + bccHex + sak + '0'.repeat(32)).slice(0, 32);
    }
    return '0'.repeat(32);
  }

  handle(raw: string): void {
    const parts = raw.trim().split(/\s+/);
    const cmd = (parts[0] ?? '').toUpperCase();
    const fam = this.card().family;

    switch (cmd) {
      case 'PING':
        this.emit('OK PONG');
        break;

      case 'VERSION':
        this.emit(`OK VERSION ${VERSION_STR}`);
        break;

      case 'HELP':
        this.emit('OK COMMANDS PING VERSION HELP SCAN READ_BLOCK WRITE_BLOCK READ_PAGE WRITE_PAGE DUMP RESCAN CLONE_READ CLONE_READ_UL MAGIC_DETECT CLONE_UID WRITE_BLOCK_RAW WRITE_TRAILER WRITE_PAGE_RAW ATS APDU BUZZER BEEP BEEPCFG');
        break;

      case 'SCAN':
      case 'UID':
      case 'READ_UID':
        this.emit(this.scanLine());
        break;

      case 'RESCAN': {
        if (parts[1] === undefined) {
          this.emit(`OK RESCAN ${this.rescanMs}`);
        } else {
          const ms = parseInt(parts[1], 10);
          this.rescanMs = Number.isFinite(ms) && ms >= 0 ? ms : 0;
          this.emit(`OK RESCAN ${this.rescanMs}`);
          this.startRescan();
        }
        break;
      }

      case 'BUZZER': {
        const arg = (parts[1] ?? '').toUpperCase();
        if (arg === '') {
          // Query.
          this.emit(`OK BUZZER ${this.buzzerOn ? 'ON' : 'OFF'}`);
        } else if (arg === 'ON' || arg === 'OFF') {
          this.buzzerOn = arg === 'ON';
          this.emit(`OK BUZZER ${arg}`);
        } else {
          this.emit('ERR UNKNOWN_COMMAND BUZZER');
        }
        break;
      }

      case 'BEEP': {
        // With no args, BEEP plays the CONFIGURED on-detect beep.
        const freq = parts[1] !== undefined ? parseInt(parts[1], 10) : this.beepFreq;
        const ms = parts[2] !== undefined ? parseInt(parts[2], 10) : this.beepMs;
        if (!Number.isFinite(freq) || !Number.isFinite(ms) || freq <= 0 || ms <= 0) {
          this.emit('ERR BAD_BEEP');
        } else {
          this.emit(`OK BEEP ${freq} ${ms}`);
        }
        break;
      }

      case 'BEEPCFG': {
        if (parts[1] === undefined) {
          // Query.
          this.emit(`OK BEEPCFG ${this.beepFreq} ${this.beepMs}`);
        } else {
          const freq = parseInt(parts[1], 10);
          const ms = parseInt(parts[2] ?? '', 10);
          const validFreq = Number.isFinite(freq) && freq >= 100 && freq <= 10000;
          const validMs = Number.isFinite(ms) && ms >= 1 && ms <= 2000;
          if (validFreq && validMs) {
            this.beepFreq = freq;
            this.beepMs = ms;
            this.emit(`OK BEEPCFG ${freq} ${ms}`);
          } else {
            this.emit('ERR BAD_BEEP');
          }
        }
        break;
      }

      case 'READ_BLOCK': {
        if (fam === 'ULTRALIGHT') { this.emit('ERR WRONG_CARD_TYPE USE=READ_PAGE'); break; }
        if (fam === 'ISO4')       { this.emit(`ERR UNSUPPORTED_CARD TYPE=${this.card().type}`); break; }
        const b = parseInt(parts[1] ?? '0', 10);
        this.emit(`OK BLOCK=${b} DATA=${this.blockData(b)}`);
        break;
      }

      case 'WRITE_BLOCK': {
        if (fam === 'ULTRALIGHT') { this.emit('ERR WRONG_CARD_TYPE USE=WRITE_PAGE'); break; }
        if (fam === 'ISO4')       { this.emit(`ERR UNSUPPORTED_CARD TYPE=${this.card().type}`); break; }
        const b = parseInt(parts[1] ?? '0', 10);
        const hex = (parts[2] ?? '').toUpperCase();
        if (b === 0) this.emit('ERR REFUSE_BLOCK_ZERO');
        else if (isTrailerBlock(b)) this.emit('ERR REFUSE_SECTOR_TRAILER');
        else if (!/^[0-9A-F]{32}$/.test(hex)) this.emit('ERR WRITE_BAD_DATA');
        else { this.blocks.set(b, hex); this.emit(`OK WROTE BLOCK=${b} DATA=${hex}`); }
        break;
      }

      case 'READ_PAGE': {
        if (fam === 'CLASSIC') { this.emit('ERR WRONG_CARD_TYPE USE=READ_BLOCK'); break; }
        if (fam === 'ISO4')    { this.emit(`ERR UNSUPPORTED_CARD TYPE=${this.card().type}`); break; }
        const p = parseInt(parts[1] ?? '0', 10);
        this.emit(`OK PAGE=${p} DATA=${this.pageData(p)}`);
        break;
      }

      case 'WRITE_PAGE': {
        if (fam === 'CLASSIC') { this.emit('ERR WRONG_CARD_TYPE USE=WRITE_BLOCK'); break; }
        if (fam === 'ISO4')    { this.emit(`ERR UNSUPPORTED_CARD TYPE=${this.card().type}`); break; }
        const p = parseInt(parts[1] ?? '0', 10);
        const hex = (parts[2] ?? '').toUpperCase();
        if (p <= 3) this.emit('ERR REFUSE_PAGE');
        else if (!/^[0-9A-F]{8}$/.test(hex)) this.emit('ERR WRITE_BAD_DATA');
        else { this.pages.set(p, hex); this.emit(`OK WROTE_PAGE PAGE=${p} DATA=${hex}`); }
        break;
      }

      case 'DUMP': {
        if (fam === 'ULTRALIGHT') { this.emit('ERR WRONG_CARD_TYPE USE=READ_PAGE'); break; }
        if (fam === 'ISO4')       { this.emit(`ERR UNSUPPORTED_CARD TYPE=${this.card().type}`); break; }
        const start = parseInt(parts[1] ?? '0', 10);
        const end = parseInt(parts[2] ?? '3', 10);
        this.emit(`OK DUMP_BEGIN UID=${this.card().uid}`);
        for (let i = start; i <= end; i++) this.emit(`BLOCK=${i} DATA=${this.blockData(i)}`);
        this.emit('OK DUMP_END');
        break;
      }

      // ── v0.3 ──────────────────────────────────────────────────────────────
      case 'CLONE_READ': {
        if (fam === 'ISO4') { this.emit(`ERR CLONE_UNSUPPORTED TYPE=${this.card().type}`); break; }
        if (fam === 'ULTRALIGHT') { this.emitUlDump(); break; }
        this.emitClassicClone();
        break;
      }

      case 'CLONE_READ_UL': {
        if (fam !== 'ULTRALIGHT') { this.emit(`ERR WRONG_CARD_TYPE USE=CLONE_READ`); break; }
        this.emitUlDump();
        break;
      }

      case 'MAGIC_DETECT': {
        const c = this.card();
        if (fam === 'ISO4') { this.emit(`ERR MAGIC_UNSUPPORTED TYPE=${c.type}`); break; }
        if (fam === 'ULTRALIGHT') {
          this.emit(`OK MAGIC TYPE=ULTRALIGHT GEN=${c.magicGen} METHOD=${c.magicMethod}`);
        } else {
          this.emit(`OK MAGIC TYPE=CLASSIC GEN=${c.magicGen} UIDLEN=${c.uidLen ?? 4} METHOD=${c.magicMethod}`);
        }
        break;
      }

      case 'CLONE_UID': {
        const c = this.card();
        if (fam !== 'CLASSIC') { this.emit(`ERR WRONG_CARD_TYPE USE=WRITE_PAGE_RAW`); break; }
        const block0 = (parts[1] ?? '').toUpperCase();
        const method = (raw.match(/METHOD=(\S+)/)?.[1] ?? 'AUTO').toUpperCase();
        if (c.magicGen === 'NORMAL') { this.emit('ERR CLONE_UID_NORMAL_CARD'); break; }
        if (!/^[0-9A-F]{32}$/.test(block0)) { this.emit('ERR CLONE_UID_BAD_BCC EXPECTED=0x00 GOT=0x00'); break; }
        // BCC check on the 4-byte UID portion.
        const uid = block0.slice(0, 8);
        let bcc = 0;
        for (let i = 0; i < 8; i += 2) bcc ^= parseInt(uid.slice(i, i + 2), 16);
        const expected = bcc.toString(16).toUpperCase().padStart(2, '0');
        const got = block0.slice(8, 10);
        if (expected !== got) {
          this.emit(`ERR CLONE_UID_BAD_BCC EXPECTED=0x${expected} GOT=0x${got}`);
          break;
        }
        const resolvedMethod = method === 'AUTO' ? c.magicGen : method;
        if (resolvedMethod === 'GEN1A' && uid.length !== 8) {
          this.emit('ERR CLONE_UID_GEN1A_4BYTE_ONLY');
          break;
        }
        // Mutate the card UID + block 0.
        const newUid = uid;
        (CARDS[this.current] as { uid: string }).uid = newUid;
        this.blocks.set(0, block0);
        this.emit(`OK CLONE_UID METHOD=${resolvedMethod} UID=${newUid}`);
        break;
      }

      case 'WRITE_BLOCK_RAW': {
        if (fam !== 'CLASSIC') { this.emit('ERR WRONG_CARD_TYPE USE=WRITE_PAGE_RAW'); break; }
        const b = parseInt(parts[1] ?? '0', 10);
        const hex = (parts[2] ?? '').toUpperCase();
        if (b === 0) this.emit('ERR REFUSE_BLOCK_ZERO');
        else if (isTrailerBlock(b)) this.emit('ERR REFUSE_SECTOR_TRAILER');
        else if (!/^[0-9A-F]{32}$/.test(hex)) this.emit('ERR WRITE_BAD_DATA');
        else { this.blocks.set(b, hex); this.emit(`OK WROTE BLOCK=${b} DATA=${hex}`); }
        break;
      }

      case 'WRITE_TRAILER': {
        if (fam !== 'CLASSIC') { this.emit('ERR WRONG_CARD_TYPE USE=WRITE_PAGE_RAW'); break; }
        const b = parseInt(parts[1] ?? '0', 10);
        const hex = (parts[2] ?? '').toUpperCase();
        if (!isTrailerBlock(b)) { this.emit('ERR NOT_A_TRAILER'); break; }
        if (!/^[0-9A-F]{32}$/.test(hex)) { this.emit('ERR TRAILER_BAD_ACCESS_BITS'); break; }
        this.blocks.set(b, hex);
        // Warn if Key A (first 12 hex) is all zeros.
        const keyA = hex.slice(0, 12);
        const warn = keyA === '000000000000' ? ' WARN=ZERO_KEYA' : '';
        this.emit(`OK WROTE_TRAILER BLOCK=${b}${warn}`);
        break;
      }

      case 'WRITE_PAGE_RAW': {
        if (fam !== 'ULTRALIGHT') { this.emit('ERR WRONG_CARD_TYPE USE=WRITE_BLOCK_RAW'); break; }
        const p = parseInt(parts[1] ?? '0', 10);
        const hex = (parts[2] ?? '').toUpperCase();
        const c = this.card();
        // OTP page 3 protection on normal cards.
        if (p === 3 && c.magicGen !== 'MAGIC') { this.emit('ERR REFUSE_PAGE_OTP'); break; }
        // Pages 0-2 (UID/cascade) only writable on magic UL.
        if (p <= 2 && c.magicGen !== 'MAGIC') { this.emit('ERR REFUSE_UL_CASCADE_BYTE'); break; }
        if (!/^[0-9A-F]{8}$/.test(hex)) { this.emit(`ERR WRITE BAD_DATA`); break; }
        this.pages.set(p, hex);
        this.emit(`OK WROTE_PAGE PAGE=${p} DATA=${hex}`);
        break;
      }

      case 'ATS': {
        const c = this.card();
        if (fam !== 'ISO4') { this.emit('ERR WRONG_CARD_TYPE'); break; }
        if (!c.ats) { this.emit('ERR NO_ATS'); break; }
        // Historical bytes = ATS minus the first (length) byte, simplified.
        this.emit(`OK ATS=${c.ats} HISTBYTES=${c.ats.slice(2)}`);
        break;
      }

      case 'APDU': {
        if (fam !== 'ISO4') { this.emit('ERR APDU_WRONG_CARD_TYPE'); break; }
        const apdu = (parts[1] ?? '').toUpperCase();
        if (apdu.length > 512) { this.emit('ERR APDU_TOO_LONG'); break; }
        if (apdu === '60') {
          this.emit('OK APDU RESP=04010133001605 SW=9100');
        } else {
          this.emit('OK APDU RESP= SW=6A82');
        }
        break;
      }

      default:
        this.emit(`ERR UNKNOWN_COMMAND ${cmd}`);
    }
  }

  private emitClassicClone(): void {
    const c = this.card();
    let okSectors = 0;
    let failedSectors = 0;
    this.emit(`OK CLONE_BEGIN UID=${c.uid} SIZE=${c.size} SAK=${c.sak} TYPE=${c.type} SECTORS=${CLASSIC_SECTORS}`);
    for (let s = 0; s < CLASSIC_SECTORS; s++) {
      const info = this.sectorInfo(s);
      this.emit(`SECTOR=${s} KEY=${info.key} KEYTYPE=${info.keyType} STATUS=${info.status}`);
      const startBlock = s * BLOCKS_PER_SECTOR;
      for (let i = 0; i < BLOCKS_PER_SECTOR; i++) {
        const b = startBlock + i;
        if (info.status === 'FAILED') {
          this.emit(`BLOCK=${b} ERR=AUTH_FAILED`);
        } else if (b === 0) {
          this.emit(`BLOCK=0 DATA=${this.block0()}`);
        } else {
          this.emit(`BLOCK=${b} DATA=${this.blockData(b)}`);
        }
      }
      if (info.status === 'OK') okSectors++; else failedSectors++;
    }
    this.emit(`OK CLONE_END OK_SECTORS=${okSectors} FAILED_SECTORS=${failedSectors}`);
  }

  private emitUlDump(): void {
    const c = this.card();
    const PAGES = 16; // small NTAG-ish image for tests
    this.emit(`OK ULDUMP_BEGIN UID=${c.uid} SIZE=${c.size} TYPE=${c.type} PAGES=${PAGES}`);
    for (let p = 0; p < PAGES; p++) {
      this.emit(`PAGE=${p} DATA=${this.pageData(p)}`);
    }
    this.emit(`OK ULDUMP_END OK_PAGES=${PAGES} FAILED_PAGES=0`);
  }
}

export class MockSerialTransport implements SerialTransport {
  readonly isSupported = true;

  private _isConnected = false;
  private lineHandlers: Set<LineHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private pico: MockPico;

  constructor() {
    this.pico = new MockPico(line => this.emitLine(line));
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitLine(line: string): void {
    this.lineHandlers.forEach(h => h(line));
  }

  private emitStatus(connected: boolean): void {
    this._isConnected = connected;
    this.statusHandlers.forEach(h => h(connected));
  }

  async connect(): Promise<void> {
    this.pico.start();
    this.emitStatus(true);
    setTimeout(() => this.pico.boot(), 50);
  }

  async disconnect(): Promise<void> {
    this.pico.reset();
    this.emitStatus(false);
  }

  async send(command: string): Promise<void> {
    setTimeout(() => this.pico.handle(command), 0);
  }

  /** Test-only: inject an unsolicited CARD_PRESENT event. Mock transport only. */
  emitCardPresent(uid?: string): void {
    this.pico.emitCardPresent(uid);
  }

  /** Test-only: select which card is "present". Mock transport only. */
  setCard(kind: MockCardKind): void {
    this.pico.setCard(kind);
  }
}
