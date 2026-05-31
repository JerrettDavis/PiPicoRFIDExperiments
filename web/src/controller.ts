import type { SerialTransport } from './serial/transport.js';
import type { OpResult, CardInfo, BlockResult } from './types.js';
import {
  parseLine, parseScanPayload,
  buildPing, buildVersion, buildHelp, buildScan,
  buildReadBlock, buildWriteBlock, buildDump,
  buildReadPage, buildWritePage, buildRescan, buildRescanQuery,
  cleanHex, sectorRange,
} from './protocol.js';

const TIMEOUT_MS = 3000;

type EventCallback = (line: string) => void;

interface Pending {
  resolve: (result: OpResult) => void;
  lines: string[];
  isDump: boolean;
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

    // Route unsolicited lines
    if (parsed.kind === 'event' || parsed.kind === 'banner') {
      this.emitEvent(line);
      return;
    }

    if (!this.pending) {
      // No in-flight request; emit as event anyway for logging
      this.emitEvent(line);
      return;
    }

    const p = this.pending;

    if (p.isDump) {
      p.lines.push(line);
      // Terminal line for DUMP
      if (parsed.kind === 'ok' && parsed.payload.startsWith('DUMP_END')) {
        this.pending = null;
        p.resolve(this.buildDumpResult(p.lines));
        this.drainQueue();
      } else if (parsed.kind === 'err') {
        this.pending = null;
        p.resolve({ ok: false, raw: line, error: parsed.payload });
        this.drainQueue();
      }
      return;
    }

    // Non-dump: first ok/err terminates
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

  private sendCommand(cmd: string, isDump = false): Promise<OpResult> {
    return new Promise<OpResult>((outerResolve) => {
      const execute = () => {
        const timer = setTimeout(() => {
          if (this.pending) {
            this.pending = null;
            outerResolve({ ok: false, raw: '', error: 'TIMEOUT' });
            this.drainQueue();
          }
        }, TIMEOUT_MS);

        this.pending = {
          resolve: (result) => {
            clearTimeout(timer);
            outerResolve(result);
          },
          lines: [],
          isDump,
        };

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
    return this.sendCommand(buildDump(start, end, k), true);
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
}
