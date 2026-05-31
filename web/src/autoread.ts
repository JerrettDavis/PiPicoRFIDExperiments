import type { RfidController } from './controller.js';
import { cleanHex } from './protocol.js';
import type { OpResult } from './types.js';

/** Idle time (ms) with no CARD_PRESENT events — AND no auto-read in flight —
 *  after which the debounce resets so re-presenting the SAME card re-reads.
 *
 *  Must comfortably exceed a full auto-read worst case. One auto-read issues
 *  two controller commands (scan + readBlock), each bounded by the controller's
 *  TIMEOUT_MS (3000ms), so worst case ~6000ms. We use 7000ms as defense-in-depth
 *  on top of the in-flight guard, so a busy reader (not emitting CARD_PRESENT
 *  while servicing our commands) is never mistaken for an absent card. */
export const ABSENCE_RESET_MS = 7000;

export interface AutoReadDeps {
  controller: RfidController;
  /** Whether auto-read is currently enabled. */
  isEnabled: () => boolean;
  /** Current block number from the UI inputs. */
  getBlock: () => number;
  /** Current Key A (raw, will be cleaned) from the UI inputs. */
  getKey: () => string;
  /** Called for each op result so the caller can render panel/badge/log. */
  onResult: (result: OpResult) => void;
  /** Optional logging hook (tx lines etc.). */
  onLog?: (line: string) => void;
}

/**
 * AutoReader hooks off unsolicited `EVENT CARD_PRESENT UID=<uid>` lines and,
 * when enabled, runs scan() then readBlock() through the existing controller
 * (so it is serialized with the in-flight queue).
 *
 * Debounce contract:
 *  - The same UID seen repeatedly triggers exactly ONE auto-read...
 *  - ...until the card is "absent": if no CARD_PRESENT arrives for
 *    ABSENCE_RESET_MS *while no auto-read is in flight*, the remembered UID is
 *    cleared so re-presenting the same card reads again.
 *  - A DIFFERENT UID always triggers a fresh auto-read immediately.
 *  - While a scan+read is in flight the card is present by definition, so the
 *    absence timer is suppressed and only (re)armed after the read completes.
 *    This prevents a busy reader (not emitting CARD_PRESENT while servicing our
 *    SCAN/READ commands) from being mistaken for an absent card and causing a
 *    spurious duplicate auto-read of the same, never-removed card.
 *
 * It NEVER triggers a write.
 */
export class AutoReader {
  private deps: AutoReadDeps;
  private lastUid: string | null = null;
  private absenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a scan+read sequence is actively running. While in-flight the
   *  card is, by definition, present — so the absence reset must not fire. */
  private inFlight = false;
  /** Injectable clock for testability of the debounce timer (defaults to setTimeout). */
  private scheduleReset: (cb: () => void) => ReturnType<typeof setTimeout>;

  constructor(
    deps: AutoReadDeps,
    scheduleReset?: (cb: () => void) => ReturnType<typeof setTimeout>,
  ) {
    this.deps = deps;
    this.scheduleReset =
      scheduleReset ?? ((cb) => setTimeout(cb, ABSENCE_RESET_MS));
  }

  /** Parse a raw line and, if it is a CARD_PRESENT event, handle it. */
  handleLine(line: string): void {
    const uid = parseCardPresent(line);
    if (uid === null) return;
    this.handleCardPresent(uid);
  }

  /** Handle a CARD_PRESENT for a specific UID (debounced). */
  handleCardPresent(uid: string): void {
    // Any CARD_PRESENT cancels the pending absence reset.
    this.clearAbsenceTimer();

    if (this.deps.isEnabled() && uid !== this.lastUid) {
      this.lastUid = uid;
      void this.runAutoRead();
      // Do NOT arm the absence timer here: runAutoRead is now in-flight and
      // will (re)arm it in its finally once the read completes.
      return;
    }

    if (this.deps.isEnabled()) {
      // Same UID: remember it so we don't re-trigger.
      this.lastUid = uid;
    }

    // (Re)arm the absence reset only when no auto-read is in flight. While
    // in-flight the card is present by definition, so we must not treat a gap
    // in CARD_PRESENT events (the reader is busy servicing our commands) as
    // the card being absent.
    this.armAbsenceTimer();
  }

  /** Reset all debounce state (e.g. on disconnect). */
  reset(): void {
    this.clearAbsenceTimer();
    this.lastUid = null;
    this.inFlight = false;
  }

  private clearAbsenceTimer(): void {
    if (this.absenceTimer !== null) {
      clearTimeout(this.absenceTimer);
      this.absenceTimer = null;
    }
  }

  /** Arm the idle-absence timer, but never while a read is in flight. */
  private armAbsenceTimer(): void {
    if (this.inFlight) return;
    this.clearAbsenceTimer();
    this.absenceTimer = this.scheduleReset(() => {
      this.absenceTimer = null;
      // Guard: if a read started in the meantime, don't clear — re-arm later.
      if (this.inFlight) return;
      this.lastUid = null;
    });
  }

  private async runAutoRead(): Promise<void> {
    const { controller, getBlock, getKey, onResult, onLog } = this.deps;
    const block = getBlock();
    const key = cleanHex(getKey());

    this.inFlight = true;
    // Cancel any absence timer that may have been armed before this read began,
    // so it cannot fire mid-read and clear lastUid.
    this.clearAbsenceTimer();
    try {
      onLog?.('SCAN');
      const scanResult = await controller.scan();
      onResult(scanResult);

      onLog?.(`READ_BLOCK ${block} ${key}`.trim());
      const readResult = await controller.readBlock(block, key || undefined);
      onResult(readResult);
    } finally {
      this.inFlight = false;
      // Now that the read is done, start counting idle time toward absence.
      this.armAbsenceTimer();
    }
  }
}

/** Pure parser: returns the UID for a CARD_PRESENT event line, else null. */
export function parseCardPresent(line: string): string | null {
  const m = line.match(/^EVENT\s+CARD_PRESENT\s+UID=(\S+)/);
  return m ? m[1]! : null;
}
