import type { RfidController } from './controller.js';
import { confirmClone } from './confirm.js';
import { deriveBlock0, trailerForBlock } from './protocol.js';
import type {
  CardImage, CardInfo, MagicInfo, CloneSummary, CloneFailure, OpResult,
} from './types.js';

export type CloneState =
  | 'IDLE'
  | 'READING'
  | 'IMAGE_READY'
  | 'DETECTING'
  | 'TARGET_DETECTED'
  | 'WRITING'
  | 'DONE';

export interface CloneDeps {
  controller: RfidController;
  /** Emitted on each state transition so the UI can react. */
  onState?: (state: CloneState) => void;
  /** Emitted with progress {done,total} during the write phase. */
  onProgress?: (done: number, total: number) => void;
  onLog?: (line: string) => void;
}

const DEFAULT_KEY = 'FFFFFFFFFFFF';

export class CloneController {
  private deps: CloneDeps;
  private _state: CloneState = 'IDLE';
  private _image: CardImage | null = null;
  private _target: CardInfo | null = null;
  private _targetMagic: MagicInfo | null = null;

  constructor(deps: CloneDeps) {
    this.deps = deps;
  }

  get state(): CloneState { return this._state; }
  get image(): CardImage | null { return this._image; }
  get target(): CardInfo | null { return this._target; }
  get targetMagic(): MagicInfo | null { return this._targetMagic; }

  private setState(s: CloneState): void {
    this._state = s;
    this.deps.onState?.(s);
  }

  reset(): void {
    this._image = null;
    this._target = null;
    this._targetMagic = null;
    this.setState('IDLE');
  }

  // ── Read source ──────────────────────────────────────────────────────────────

  /** Read the source card into an image. Returns the OpResult for rendering. */
  async readSource(): Promise<OpResult> {
    this.setState('READING');
    this.deps.onLog?.('CLONE_READ');
    const result = await this.deps.controller.cloneRead();
    if (result.ok && result.image) {
      this._image = result.image;
      this.setState('IMAGE_READY');
    } else {
      // ISO4 → CLONE_UNSUPPORTED, or any failure: stay without an image.
      this.setState('IDLE');
    }
    return result;
  }

  // ── Detect target ──────────────────────────────────────────────────────────

  /**
   * Scan + magic-detect the (target) card. Blocks if the target family differs
   * from the captured source family. Returns the merged OpResult-ish info.
   */
  async detectTarget(): Promise<{ scan: OpResult; magic: OpResult; blocked?: string }> {
    this.setState('DETECTING');
    this.deps.onLog?.('SCAN');
    const scan = await this.deps.controller.scan();
    this.deps.onLog?.('MAGIC_DETECT');
    const magic = await this.deps.controller.magicDetect();

    if (scan.ok && scan.card) this._target = scan.card;
    if (magic.ok && magic.magic) this._targetMagic = magic.magic;

    let blocked: string | undefined;
    if (this._image && this._target && this._target.family !== this._image.family) {
      blocked = `Target family ${this._target.family} != source family ${this._image.family}`;
      // Remain not-ready for writing.
      this.setState('IMAGE_READY');
      return { scan, magic, blocked };
    }

    if (this._target) {
      this.setState('TARGET_DETECTED');
    } else {
      this.setState('IMAGE_READY');
    }
    return { scan, magic };
  }

  // ── Write clone ──────────────────────────────────────────────────────────────

  /**
   * Gate on confirmClone, then perform the bulk write in the safe order.
   * If the user cancels confirmation, NOTHING is written and null is returned.
   */
  async writeClone(): Promise<CloneSummary | null> {
    const image = this._image;
    const target = this._target;
    const magic = this._targetMagic;
    if (!image || !target) return null;

    const isUl = image.family === 'ULTRALIGHT';

    // Compute what the UID clone will do, for the confirm summary.
    const { uidWillClone, uidMethod, warnings: preWarnings } =
      this.planUidClone(image, magic);

    const total = this.countWritableUnits(image);

    const confirmed = await confirmClone({
      sourceUid: image.uid,
      targetUid: target.uid,
      family: image.family,
      blockOrPageCount: total,
      uidWillClone,
      uidMethod,
      warnings: preWarnings,
    });
    if (!confirmed) return null; // cancel → write NOTHING

    this.setState('WRITING');
    const summary: CloneSummary = {
      written: 0,
      failed: [],
      uidCloned: false,
      uidMethod,
      warnings: [...preWarnings],
    };

    let done = 0;
    const tick = () => { done++; this.deps.onProgress?.(done, total); };

    if (isUl) {
      await this.writeUl(image, magic, summary, tick);
    } else {
      await this.writeClassic(image, magic, summary, tick);
    }

    this.setState('DONE');
    return summary;
  }

  // Count blocks/pages that will be written (excludes trailers handled separately
  // for Classic; for the confirm summary we use a simple writable-unit count).
  private countWritableUnits(image: CardImage): number {
    if (image.family === 'ULTRALIGHT') {
      return (image.pages ?? []).filter(p => p.data !== undefined).length;
    }
    let n = 0;
    for (const sec of image.sectors ?? []) {
      for (const blk of sec.blocks) {
        if (blk.data === undefined) continue;
        n++; // data blocks + trailers + block0 are all written
      }
    }
    return n;
  }

  private planUidClone(image: CardImage, magic: MagicInfo | null):
    { uidWillClone: boolean; uidMethod: string; warnings: string[] } {
    const warnings: string[] = [];
    if (image.family === 'ULTRALIGHT') {
      if (magic && magic.gen === 'MAGIC' && magic.method === 'DIRECT') {
        return { uidWillClone: true, uidMethod: 'UL_MAGIC', warnings };
      }
      warnings.push('Target is a normal Ultralight — UID/pages 0-2 cannot be cloned');
      return { uidWillClone: false, uidMethod: 'NORMAL_CARD', warnings };
    }
    // Classic
    if (magic && (magic.gen === 'GEN1A' || magic.gen === 'GEN2') && magic.method !== 'NONE') {
      return { uidWillClone: true, uidMethod: magic.gen, warnings };
    }
    warnings.push('Target is a normal Classic card — UID/block 0 cannot be cloned');
    return { uidWillClone: false, uidMethod: 'NORMAL_CARD', warnings };
  }

  private async writeClassic(
    image: CardImage,
    magic: MagicInfo | null,
    summary: CloneSummary,
    tick: () => void,
  ): Promise<void> {
    const c = this.deps.controller;

    // 1) Data blocks first (everything that is NOT block 0 and NOT a trailer).
    for (const sec of image.sectors ?? []) {
      const key = sec.key && sec.key !== '------------' ? sec.key : DEFAULT_KEY;
      for (const blk of sec.blocks) {
        if (blk.data === undefined) continue;
        if (blk.block === 0) continue;
        if (trailerForBlock(blk.block) === blk.block) continue;
        this.deps.onLog?.(`WRITE_BLOCK_RAW ${blk.block}`);
        const r = await c.writeBlockRaw(blk.block, blk.data, key);
        this.tally(r, blk.block, summary);
        tick();
      }
    }

    // 2) Sector trailers.
    for (const sec of image.sectors ?? []) {
      const key = sec.key && sec.key !== '------------' ? sec.key : DEFAULT_KEY;
      for (const blk of sec.blocks) {
        if (blk.data === undefined) continue;
        if (trailerForBlock(blk.block) !== blk.block) continue;
        this.deps.onLog?.(`WRITE_TRAILER ${blk.block}`);
        const r = await c.writeTrailer(blk.block, blk.data, key);
        this.tally(r, blk.block, summary);
        tick();
      }
    }

    // 3) Block 0 / UID LAST, only if the target is magic.
    if (magic && (magic.gen === 'GEN1A' || magic.gen === 'GEN2') && magic.method !== 'NONE') {
      const block0 = deriveBlock0(image);
      if (block0) {
        const method = magic.gen; // GEN1A | GEN2
        this.deps.onLog?.(`CLONE_UID METHOD=${method}`);
        const r = await c.cloneUid(block0, method);
        if (r.ok) {
          summary.uidCloned = true;
          summary.uidMethod = method;
          // count block0 in written total
          summary.written++;
        } else {
          summary.failed.push({ addr: 0, err: r.error ?? 'CLONE_UID_FAILED' });
          summary.uidCloned = false;
        }
        tick();
      }
    }
    // else: normal card — block 0 left as-is; uidCloned stays false.
  }

  private async writeUl(
    image: CardImage,
    magic: MagicInfo | null,
    summary: CloneSummary,
    tick: () => void,
  ): Promise<void> {
    const c = this.deps.controller;
    const pages = (image.pages ?? []).filter(p => p.data !== undefined);

    // 1) Data pages first (page >= 4 user-writable; 3 is OTP, handle conservatively
    //    by treating pages >= 4 as data, leaving 0-2 for the magic step).
    for (const p of pages) {
      if (p.page < 4) continue;
      this.deps.onLog?.(`WRITE_PAGE_RAW ${p.page}`);
      const r = await c.writePageRaw(p.page, p.data!);
      this.tally(r, p.page, summary);
      tick();
    }

    // 2) Pages 0-2 LAST, only if magic.
    const canMagic = magic && magic.gen === 'MAGIC' && magic.method === 'DIRECT';
    for (const p of pages) {
      if (p.page > 2) continue;
      if (!canMagic) {
        summary.failed.push({ addr: p.page, err: 'REFUSE_UL_CASCADE_BYTE' });
        tick();
        continue;
      }
      this.deps.onLog?.(`WRITE_PAGE_RAW ${p.page}`);
      const r = await c.writePageRaw(p.page, p.data!);
      if (r.ok) {
        summary.written++;
        summary.uidCloned = true;
        summary.uidMethod = 'UL_MAGIC';
      } else {
        summary.failed.push({ addr: p.page, err: r.error ?? 'WRITE_FAILED' });
      }
      tick();
    }
  }

  private tally(r: OpResult, addr: number, summary: CloneSummary): void {
    if (r.ok) {
      summary.written++;
    } else {
      const f: CloneFailure = { addr, err: r.error ?? 'WRITE_FAILED' };
      summary.failed.push(f);
    }
  }

  // ── JSON round-trip ──────────────────────────────────────────────────────────

  exportJson(): string {
    return JSON.stringify(this._image, null, 2);
  }

  importJson(json: string): CardImage {
    const image = JSON.parse(json) as CardImage;
    this._image = image;
    this.setState('IMAGE_READY');
    return image;
  }
}
