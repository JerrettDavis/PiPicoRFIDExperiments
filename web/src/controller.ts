import type { SerialTransport } from './serial/transport.js';
import type { OpResult, CardInfo, BlockResult } from './types.js';
import {
  parseLine, parseScanPayload,
  parseCloneStream, parseMagic, parseAts, parseApdu,
  buildPing, buildVersion, buildHelp, buildScan,
  buildReadBlock, buildWriteBlock, buildDump,
  buildReadPage, buildWritePage, buildRescan, buildRescanQuery,
  buildCloneRead, buildCloneReadUl, buildMagicDetect, buildCloneUid,
  buildWriteBlockRaw, buildWriteTrailer, buildWritePageRaw, buildAts, buildApdu,
  cleanHex, sectorRange,
} from './protocol.js';

const TIMEOUT_MS = 3000;
/** Clone reads (full 4K dumps) can far exceed the default per-command timeout. */
const CLONE_TIMEOUT_MS = 30000;

type EventCallback = (line: string) => void;

/** Returns true when the given OK payload is the terminal line of a stream. */
type StreamEnd = (payload: string) => boolean;

interface Pending {
  resolve: (result: OpResult) => void;
  lines: string[];
  /** When set, the request streams lines until this returns true for an OK line. */
  streamEnd?: StreamEnd;
  /** Builds the OpResult from the accumulated stream lines. */
  buildStream?: (lines: string[]) => OpResult;
}

export class RfidController {
  private transport: SerialTransport;
  private pending: Pending | null = null;
  private queue: Array<() => void> = [];
  private eventCallbacks: Set<EventCallback> = new Set();

  constructor(transport: SerialTransport) {
    this.transport = transport;
    transport.onLine(line => this.handleLine(line));
  }

  onEvent(cb: EventCallback): () => void {
    this.eventCallbacks.add(cb);
    return () => this.eventCallbacks.delete(cb);
  }

  private emitEvent(line: string): void {
    this.eventCallbacks.forEach(cb => cb(line));
  }

  private handleLine(line: string): void {
    const parsed = parseLine(line);

    // Genuine unsolicited events (EVENT CARD_PRESENT) are ALWAYS routed to the
    // event callback, even mid-stream, so auto-read keeps working.
    if (parsed.kind === 'event') {
      this.emitEvent(line);
      return;
    }

    const p = this.pending;

    // Generalized streaming request (DUMP, CLONE_READ, CLONE_READ_UL).
    // While a stream is in flight, ALL non-event lines (SECTOR=, BLOCK=, PAGE=,
    // banner-shaped intermediate lines, and the terminal OK ..._END) belong to
    // the stream, not the unsolicited-event path.
    if (p && p.streamEnd) {
      p.lines.push(line);
      if (parsed.kind === 'ok' && p.streamEnd(parsed.payload)) {
        this.pending = null;
        const build = p.buildStream ?? ((ls) => this.buildDumpResult(ls));
        p.resolve(build(p.lines));
        this.drainQueue();
      } else if (parsed.kind === 'err') {
        // A top-level ERR (e.g. CLONE_UNSUPPORTED) terminates the stream.
        this.pending = null;
        p.resolve({ ok: false, raw: line, error: parsed.payload });
        this.drainQueue();
      }
      return;
    }

    // Non-streaming: route banners (READY/PINS) and idle lines to events.
    if (parsed.kind === 'banner') {
      this.emitEvent(line);
      return;
    }

    if (!p) {
      // No in-flight request; emit as event anyway for logging
      this.emitEvent(line);
      return;
    }

    // Non-streaming: first ok/err terminates
    if (parsed.kind === 'ok' || parsed.kind === 'err') {
      this.pending = null;
      p.resolve(this.buildResult(parsed.kind === 'ok', line, parsed.payload));
      this.drainQueue();
    }
  }

  private buildResult(ok: boolean, raw: string, payload: string): OpResult {
    if (!ok) return { ok: false, raw, error: payload };

    // Parse SCAN/UID response (v0.2, by key): UID=.. SIZE=.. SAK=.. TYPE=..
    const card = parseScanPayload(payload);
    if (card) {
      return { ok: true, raw, card };
    }

    // Parse RESCAN response: RESCAN <ms>
    const rescanMatch = payload.match(/^RESCAN\s+(\d+)/);
    if (rescanMatch) {
      return { ok: true, raw, rescan: parseInt(rescanMatch[1]!, 10) };
    }

    // v0.3 scalar responses.
    if (payload.startsWith('MAGIC ')) {
      return { ok: true, raw, magic: parseMagic(payload) };
    }
    if (payload.startsWith('ATS=')) {
      return { ok: true, raw, ats: parseAts(payload) };
    }
    if (payload.startsWith('APDU ')) {
      return { ok: true, raw, apdu: parseApdu(payload) };
    }
    // CLONE_UID: `CLONE_UID METHOD=<GEN1A|GEN2> UID=<hex>` — surface card UID.
    if (payload.startsWith('CLONE_UID ')) {
      const uid = payload.match(/\bUID=(\S+)/)?.[1] ?? '';
      const card: CardInfo = { uid, size: 0, sak: '', type: 'UNKNOWN', family: 'UNKNOWN' };
      return { ok: true, raw, card };
    }

    // Parse PAGE response: PAGE=4 DATA=...  (and WROTE_PAGE PAGE=4 DATA=...)
    if (payload.includes('PAGE=') && payload.includes('DATA=')) {
      const page = parseInt(payload.match(/PAGE=(\d+)/)?.[1] ?? '0', 10);
      const data = payload.match(/DATA=([0-9A-Fa-f]+)/)?.[1] ?? '';
      return { ok: true, raw, page: { page, data } };
    }

    // Parse BLOCK response: BLOCK=4 DATA=... (and WROTE BLOCK=4 DATA=...)
    if (payload.includes('BLOCK=') && payload.includes('DATA=')) {
      const block = parseInt(payload.match(/BLOCK=(\d+)/)?.[1] ?? '0', 10);
      const data = payload.match(/DATA=([0-9A-Fa-f]+)/)?.[1] ?? '';
      return { ok: true, raw, block: { block, data } };
    }

    return { ok: true, raw };
  }

  private buildDumpResult(lines: string[]): OpResult {
    const blocks: BlockResult[] = [];
    let uid = '';
    let hasError = false;
    let errorMsg = '';

    for (const line of lines) {
      const p = parseLine(line);
      if (p.kind === 'ok' && p.payload.includes('DUMP_BEGIN')) {
        uid = p.payload.match(/UID=([^\s]+)/)?.[1] ?? '';
      } else if (p.kind === 'data') {
        const block = parseInt(p.payload.match(/BLOCK=(\d+)/)?.[1] ?? '0', 10);
        const data = p.payload.match(/DATA=([0-9A-Fa-f]+)/)?.[1] ?? '';
        blocks.push({ block, data });
      } else if (p.kind === 'err') {
        hasError = true;
        errorMsg = p.payload;
      }
    }

    if (hasError) return { ok: false, raw: lines.join('\n'), error: errorMsg };
    const card: CardInfo | undefined = uid
      ? { uid, size: 0, sak: '', type: 'UNKNOWN', family: 'UNKNOWN' }
      : undefined;
    return { ok: true, raw: lines.join('\n'), card, blocks };
  }

  private drainQueue(): void {
    const next = this.queue.shift();
    if (next) next();
  }

  private sendCommand(
    cmd: string,
    opts: {
      streamEnd?: StreamEnd;
      buildStream?: (lines: string[]) => OpResult;
      timeoutMs?: number;
    } = {},
  ): Promise<OpResult> {
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    return new Promise<OpResult>((outerResolve) => {
      const execute = () => {
        const timer = setTimeout(() => {
          if (this.pending) {
            this.pending = null;
            outerResolve({ ok: false, raw: '', error: 'TIMEOUT' });
            this.drainQueue();
          }
        }, timeoutMs);

        const pending: Pending = {
          resolve: (result) => {
            clearTimeout(timer);
            outerResolve(result);
          },
          lines: [],
        };
        if (opts.streamEnd) pending.streamEnd = opts.streamEnd;
        if (opts.buildStream) pending.buildStream = opts.buildStream;
        this.pending = pending;

        this.transport.send(cmd).catch(err => {
          clearTimeout(timer);
          this.pending = null;
          outerResolve({ ok: false, raw: '', error: String(err) });
          this.drainQueue();
        });
      };

      if (this.pending) {
        this.queue.push(execute);
      } else {
        execute();
      }
    });
  }

  async ping(): Promise<OpResult> {
    return this.sendCommand(buildPing());
  }

  async version(): Promise<OpResult> {
    return this.sendCommand(buildVersion());
  }

  async help(): Promise<OpResult> {
    return this.sendCommand(buildHelp());
  }

  async scan(): Promise<OpResult> {
    return this.sendCommand(buildScan());
  }

  async readBlock(block: number, key?: string): Promise<OpResult> {
    const k = key ? cleanHex(key) : undefined;
    return this.sendCommand(buildReadBlock(block, k));
  }

  async writeBlock(block: number, hex: string, key?: string): Promise<OpResult> {
    const k = key ? cleanHex(key) : undefined;
    return this.sendCommand(buildWriteBlock(block, cleanHex(hex), k));
  }

  async dump(block: number, key?: string): Promise<OpResult> {
    const { start, end } = sectorRange(block);
    const k = key ? cleanHex(key) : undefined;
    return this.sendCommand(buildDump(start, end, k), {
      streamEnd: (payload) => payload.startsWith('DUMP_END'),
      buildStream: (lines) => this.buildDumpResult(lines),
    });
  }

  // ── v0.2: Ultralight/NTAG page ops ──────────────────────────────────────────

  async readPage(page: number): Promise<OpResult> {
    return this.sendCommand(buildReadPage(page));
  }

  async writePage(page: number, hex: string): Promise<OpResult> {
    return this.sendCommand(buildWritePage(page, cleanHex(hex)));
  }

  // ── v0.2: configurable re-scan interval ──────────────────────────────────────

  async rescan(ms: number): Promise<OpResult> {
    return this.sendCommand(buildRescan(ms));
  }

  async rescanQuery(): Promise<OpResult> {
    return this.sendCommand(buildRescanQuery());
  }

  // ── v0.3: clone workflow ─────────────────────────────────────────────────────

  /**
   * Read a full source image. Classic streams CLONE_BEGIN..CLONE_END; Ultralight
   * streams ULDUMP_BEGIN..ULDUMP_END. Uses an extended 30s timeout because 4K
   * dumps far exceed the 3s default. ISO4 → ERR CLONE_UNSUPPORTED.
   */
  async cloneRead(): Promise<OpResult> {
    return this.sendCommand(buildCloneRead(), {
      streamEnd: (payload) =>
        payload.startsWith('CLONE_END') || payload.startsWith('ULDUMP_END'),
      buildStream: (lines) => ({ ok: true, raw: lines.join('\n'), image: parseCloneStream(lines) }),
      timeoutMs: CLONE_TIMEOUT_MS,
    });
  }

  /** Explicit Ultralight image read (ULDUMP framing). */
  async cloneReadUl(): Promise<OpResult> {
    return this.sendCommand(buildCloneReadUl(), {
      streamEnd: (payload) => payload.startsWith('ULDUMP_END'),
      buildStream: (lines) => ({ ok: true, raw: lines.join('\n'), image: parseCloneStream(lines) }),
      timeoutMs: CLONE_TIMEOUT_MS,
    });
  }

  async magicDetect(): Promise<OpResult> {
    return this.sendCommand(buildMagicDetect());
  }

  async cloneUid(block0: string, method: string): Promise<OpResult> {
    return this.sendCommand(buildCloneUid(block0, method));
  }

  async writeBlockRaw(block: number, hex: string, key: string): Promise<OpResult> {
    return this.sendCommand(buildWriteBlockRaw(block, hex, key));
  }

  async writeTrailer(trailerBlock: number, hex: string, key: string): Promise<OpResult> {
    return this.sendCommand(buildWriteTrailer(trailerBlock, hex, key));
  }

  async writePageRaw(page: number, hex: string): Promise<OpResult> {
    return this.sendCommand(buildWritePageRaw(page, hex));
  }

  async ats(): Promise<OpResult> {
    return this.sendCommand(buildAts());
  }

  async apdu(hex: string): Promise<OpResult> {
    return this.sendCommand(buildApdu(hex));
  }
}
