import type { SerialTransport, LineHandler, StatusHandler } from './transport.js';

const UID = 'DEADBEEF';
const SAK = '0x08';
const TYPE = 'MIFARE_1K';
const DEFAULT_KEY = 'FFFFFFFFFFFF';
const VERSION_STR = '0x92';

function isTrailer(b: number): boolean {
  return b % 4 === 3;
}

class MockPico {
  private blocks: Map<number, string> = new Map();
  private emitLine: (line: string) => void;

  constructor(emitLine: (line: string) => void) {
    this.emitLine = emitLine;
    // Seed block 4
    this.blocks.set(4, '48656C6C6F2066726F6D205069636F21');
  }

  private data(b: number): string {
    return this.blocks.get(b) ?? '00'.repeat(16);
  }

  private emit(line: string): void {
    setTimeout(() => this.emitLine(line), 0);
  }

  boot(): void {
    this.emit(`READY RP2040_RFID_USB 0.1.0`);
    this.emit(`PINS SS=17 SCK=18 MOSI=19 MISO=16 RST=20 IRQ=21`);
    this.emit(`EVENT CARD_PRESENT UID=${UID}`);
  }

  handle(raw: string): void {
    const parts = raw.trim().split(/\s+/);
    const cmd = (parts[0] ?? '').toUpperCase();

    switch (cmd) {
      case 'PING':
        this.emit('OK PONG');
        break;

      case 'VERSION':
        this.emit(`OK VERSION ${VERSION_STR}`);
        break;

      case 'HELP':
        this.emit('OK COMMANDS PING VERSION HELP SCAN READ_BLOCK WRITE_BLOCK DUMP');
        break;

      case 'SCAN':
      case 'UID':
      case 'READ_UID':
        this.emit(`OK UID=${UID} SAK=${SAK} TYPE=${TYPE}`);
        break;

      case 'READ_BLOCK': {
        const b = parseInt(parts[1] ?? '0', 10);
        const _key = parts[2] ?? DEFAULT_KEY; void _key;
        this.emit(`OK BLOCK=${b} DATA=${this.data(b)}`);
        break;
      }

      case 'WRITE_BLOCK': {
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

      case 'DUMP': {
        const start = parseInt(parts[1] ?? '0', 10);
        const end = parseInt(parts[2] ?? '3', 10);
        const _key = parts[3] ?? DEFAULT_KEY; void _key;
        this.emit(`OK DUMP_BEGIN UID=${UID}`);
        for (let i = start; i <= end; i++) {
          this.emit(`BLOCK=${i} DATA=${this.data(i)}`);
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
    this.emitStatus(true);
    setTimeout(() => this.pico.boot(), 50);
  }

  async disconnect(): Promise<void> {
    this.emitStatus(false);
  }

  async send(command: string): Promise<void> {
    setTimeout(() => this.pico.handle(command), 0);
  }

  /**
   * Test-only: inject an unsolicited `EVENT CARD_PRESENT UID=<uid>` line
   * through the same path the firmware would use. Used to drive auto-read /
   * debounce tests deterministically. Mock transport only.
   */
  emitCardPresent(uid: string): void {
    this.emitLine(`EVENT CARD_PRESENT UID=${uid}`);
  }
}
