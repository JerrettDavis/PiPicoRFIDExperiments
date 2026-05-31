import type { RfidController } from './controller.js';
import { cleanHex } from './protocol.js';
import type { OpResult, CardFamily } from './types.js';

export interface AutoReadDeps {
  controller: RfidController;
  /** Whether auto-read is currently enabled. */
  isEnabled: () => boolean;
  /** Current block number (CLASSIC) from the UI inputs. */
  getBlock: () => number;
  /** Current Key A (raw, will be cleaned) from the UI inputs. */
  getKey: () => string;
  /** Current page number (ULTRALIGHT) from the UI inputs. */
  getPage: () => number;
  /** Called for each op result so the caller can render panel/badge/log. */
  onResult: (result: OpResult) => void;
  /** Optional logging hook (tx lines etc.). */
  onLog?: (line: string) => void;
}

/**
 * AutoReader hooks off unsolicited `EVENT CARD_PRESENT UID=<uid>` lines.
 *
 * v0.2 model (firmware controls cadence via RESCAN):
 *  - When enabled, trigger a read on EACH received CARD_PRESENT event.
 *  - There is no same-UID suppression anymore — the firmware's RESCAN interval
 *    governs how often CARD_PRESENT (and thus auto-read) repeats. The UID is
 *    still tracked for display purposes only.
 *  - Reads are guarded by an `inFlight` flag so an event arriving while a read
 *    is still running does not start an overlapping read (it is dropped).
 *  - The read is TYPE-AWARE: scan() first to learn the card type, then:
 *      CLASSIC    -> readBlock(addr, key)
 *      ULTRALIGHT -> readPage(addr)
 *      ISO4/UNKNOWN -> nothing further (UID/type only)
 *
 * It NEVER triggers a write.
 */
export class AutoReader {
  private deps: AutoReadDeps;
  /** Last UID seen (display/tracking only; not used for suppression). */
  private lastUid: string | null = null;
  /** True while a scan(+read) sequence is actively running. Guards overlap. */
  private inFlight = false;

  constructor(deps: AutoReadDeps) {
    this.deps = deps;
  }

  /** Parse a raw line and, if it is a CARD_PRESENT event, handle it. */
  handleLine(line: string): void {
    const uid = parseCardPresent(line);
    if (uid === null) return;
    this.handleCardPresent(uid);
  }

  /** Handle a CARD_PRESENT for a specific UID. Reads once per event when
   *  enabled and not already reading. */
  handleCardPresent(uid: string): void {
    this.lastUid = uid; // track for display only
    if (!this.deps.isEnabled()) return;
    if (this.inFlight) return; // guard against overlapping reads
    void this.runAutoRead();
  }

  /** Last UID seen (display/tracking only). */
  getLastUid(): string | null {
    return this.lastUid;
  }

  /** Reset state (e.g. on disconnect). */
  reset(): void {
    this.lastUid = null;
    this.inFlight = false;
  }

  private async runAutoRead(): Promise<void> {
    const { controller, getBlock, getKey, getPage, onResult, onLog } = this.deps;

    this.inFlight = true;
    try {
      onLog?.('SCAN');
      const scanResult = await controller.scan();
      onResult(scanResult);

      const family: CardFamily | undefined = scanResult.card?.family;

      if (family === 'CLASSIC') {
        const block = getBlock();
        const key = cleanHex(getKey());
        onLog?.(`READ_BLOCK ${block} ${key}`.trim());
        const readResult = await controller.readBlock(block, key || undefined);
        onResult(readResult);
      } else if (family === 'ULTRALIGHT') {
        const page = getPage();
        onLog?.(`READ_PAGE ${page}`);
        const readResult = await controller.readPage(page);
        onResult(readResult);
      }
      // ISO4 / UNKNOWN: UID/type only — no block/page read.
    } finally {
      this.inFlight = false;
    }
  }
}

/** Pure parser: returns the UID for a CARD_PRESENT event line, else null. */
export function parseCardPresent(line: string): string | null {
  const m = line.match(/^EVENT\s+CARD_PRESENT\s+UID=(\S+)/);
  return m ? m[1]! : null;
}
