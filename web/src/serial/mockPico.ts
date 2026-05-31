import type { SerialTransport, LineHandler, StatusHandler } from './transport.js';

const DEFAULT_KEY = 'FFFFFFFFFFFF';
const VERSION_STR = '0x92';

export type MockCardKind = 'classic' | 'ultralight' | 'iso4';

interface CardModel {
  uid: string;
  size: number;
  sak: string;
  type: string;
  family: 'CLASSIC' | 'ULTRALIGHT' | 'ISO4';
}

const CARDS: Record<MockCardKind, CardModel> = {
  classic:    { uid: 'DEADBEEF',       size: 4, sak: '0x08', type: 'MIFARE_1K',    family: 'CLASSIC' },
  ultralight: { uid: '04A1B2C3D4E5F6', size: 7, sak: '0x00', type: 'MIFARE_UL',    family: 'ULTRALIGHT' },
  iso4:       { uid: '04666BA27A1890', size: 7, sak: '0x20', type: 'ISO_14443_4',  family: 'ISO4' },
};

function isTrailer(b: number): boolean {
  return b % 4 === 3;
}

class MockPico {
  /** Classic 1K data blocks. */
  private blocks: Map<number, string> = new Map();
  /** Ultralight pages (4 bytes / 8 hex each). */
  private pages: Map<number, string> = new Map();
  /** Currently-present card. */
  private current: MockCardKind = 'classic';
  /** Re-scan interval (ms); 0 = disabled. */
  private rescanMs = 0;
  /** Timer re-emitting CARD_PRESENT while rescanMs > 0. */
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  /** When true, deferred emits and rescan callbacks are suppressed (post-reset). */
  private destroyed = false;

  private emitLine: (line: string) => void;

  constructor(emitLine: (line: string) => void) {
    this.emitLine = emitLine;
    // Classic 1K: seed block 4.
    this.blocks.set(4, '48656C6C6F2066726F6D205069636F21');
    // Ultralight: seed page 4 (4 bytes = 8 hex).
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

  private emit(line: string): void {
    setTimeout(() => {
      if (!this.destroyed) this.emitLine(line);
    }, 0);
  }

  /** (Re)enable emits for a fresh connection. */
  start(): void {
    this.destroyed = false;
  }

  boot(): void {
    this.emit(`READY RP2040_RFID_USB 0.2.0`);
    this.emit(`PINS SS=17 SCK=18 MOSI=19 MISO=16 RST=20 IRQ=21`);
    this.emit(`EVENT CARD_PRESENT UID=${this.card().uid}`);
  }

  /** Test-only: emit a CARD_PRESENT for the current card. */
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
        this.emit('OK COMMANDS PING VERSION HELP SCAN READ_BLOCK WRITE_BLOCK READ_PAGE WRITE_PAGE DUMP RESCAN');
        break;

      case 'SCAN':
      case 'UID':
      case 'READ_UID': {
        const c = this.card();
        this.emit(`OK UID=${c.uid} SIZE=${c.size} SAK=${c.sak} TYPE=${c.type}`);
        break;
      }

      case 'RESCAN': {
        if (parts[1] === undefined) {
          // Query
          this.emit(`OK RESCAN ${this.rescanMs}`);
        } else {
          const ms = parseInt(parts[1], 10);
          this.rescanMs = Number.isFinite(ms) && ms >= 0 ? ms : 0;
          this.emit(`OK RESCAN ${this.rescanMs}`);
          this.startRescan();
        }
        break;
      }

      case 'READ_BLOCK': {
        if (fam === 'ULTRALIGHT') { this.emit('ERR WRONG_CARD_TYPE USE=READ_PAGE'); break; }
        if (fam === 'ISO4')       { this.emit(`ERR UNSUPPORTED_CARD TYPE=${this.card().type}`); break; }
        const b = parseInt(parts[1] ?? '0', 10);
        const _key = parts[2] ?? DEFAULT_KEY; void _key;
        this.emit(`OK BLOCK=${b} DATA=${this.blockData(b)}`);
        break;
      }

      case 'WRITE_BLOCK': {
        if (fam === 'ULTRALIGHT') { this.emit('ERR WRONG_CARD_TYPE USE=WRITE_PAGE'); break; }
        if (fam === 'ISO4')       { this.emit(`ERR UNSUPPORTED_CARD TYPE=${this.card().type}`); break; }
        const b = parseInt(parts[1] ?? '0', 10);
        const hex = (parts[2] ?? '').toUpperCase();
        const _key = parts[3] ?? DEFAULT_KEY; void _key;
        if (b === 0) {
          this.emit('ERR REFUSE_BLOCK_ZERO');
        } else if (isTrailer(b)) {
          this.emit('ERR REFUSE_SECTOR_TRAILER');
        } else if (!/^[0-9A-F]{32}$/.test(hex)) {
          this.emit('ERR WRITE_BAD_DATA');
        } else {
          this.blocks.set(b, hex);
          this.emit(`OK WROTE BLOCK=${b} DATA=${hex}`);
        }
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
        if (p <= 3) {
          this.emit('ERR REFUSE_PAGE');
        } else if (!/^[0-9A-F]{8}$/.test(hex)) {
          this.emit('ERR WRITE_BAD_DATA');
        } else {
          this.pages.set(p, hex);
          this.emit(`OK WROTE_PAGE PAGE=${p} DATA=${hex}`);
        }
        break;
      }

      case 'DUMP': {
        if (fam === 'ULTRALIGHT') { this.emit('ERR WRONG_CARD_TYPE USE=READ_PAGE'); break; }
        if (fam === 'ISO4')       { this.emit(`ERR UNSUPPORTED_CARD TYPE=${this.card().type}`); break; }
        const start = parseInt(parts[1] ?? '0', 10);
        const end = parseInt(parts[2] ?? '3', 10);
        const _key = parts[3] ?? DEFAULT_KEY; void _key;
        this.emit(`OK DUMP_BEGIN UID=${this.card().uid}`);
        for (let i = start; i <= end; i++) {
          this.emit(`BLOCK=${i} DATA=${this.blockData(i)}`);
        }
        this.emit('OK DUMP_END');
        break;
      }

      default:
        this.emit(`ERR UNKNOWN_COMMAND ${cmd}`);
    }
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
    this.pico.start(); // re-enable emits for this (re)connection
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

  /**
   * Test-only: inject an unsolicited `EVENT CARD_PRESENT UID=<uid>` line
   * through the same path the firmware would use. Used to drive auto-read
   * tests deterministically. Mock transport only.
   */
  emitCardPresent(uid?: string): void {
    this.pico.emitCardPresent(uid);
  }

  /**
   * Test-only: select which card is "present" at the reader so subsequent
   * SCAN / READ_* commands behave per that card type. Mock transport only.
   */
  setCard(kind: MockCardKind): void {
    this.pico.setCard(kind);
  }
}
