import type { RfidController } from './controller.js';
import { confirmWrite } from './confirm.js';
import { cleanHex, trailerForBlock } from './protocol.js';
import type { OpResult } from './types.js';

export type WriteKind = 'block' | 'page';

export interface EditDeps {
  controller: RfidController;
  onLog: (line: string) => void;
  onResult: (result: OpResult) => void;
  renderWriteError: (msg: string) => void;
  clearWriteError: () => void;
  renderPageWriteError: (msg: string) => void;
  clearPageWriteError: () => void;
  /** Called after a successful OK WROTE / WROTE_PAGE so the map can refresh. */
  onWritten?: (kind: WriteKind, addr: number, hex: string) => void;
}

/**
 * Single write path for both the Edit tab and the Console raw-WRITE route.
 * Relocated VERBATIM from the previous main.ts doWrite/doWritePage: same
 * validations (block-0 refusal, trailer refusal, 32-hex; page<=3 refusal,
 * 8-hex) and the SAME confirmWrite two-step gating.
 */
export class EditController {
  private deps: EditDeps;

  constructor(deps: EditDeps) {
    this.deps = deps;
  }

  async writeBlock(block: number, hex: string, key: string): Promise<void> {
    const d = this.deps;
    // Pre-validate before opening modal
    if (block === 0) {
      d.renderWriteError('Block 0 is protected (UID/manufacturer data).');
      return;
    }
    if (trailerForBlock(block) === block) {
      d.renderWriteError(`Block ${block} is a sector trailer — writes refused.`);
      return;
    }
    if (hex.length !== 32) {
      d.renderWriteError(`Data must be exactly 32 hex chars (got ${hex.length}).`);
      return;
    }
    d.clearWriteError();

    const confirmed = await confirmWrite({ block, data: hex, key });
    if (!confirmed) return;

    d.onLog(`WRITE_BLOCK ${block} ${hex} ${key}`.trim());
    const result = await this.deps.controller.writeBlock(block, hex, key || undefined);
    d.onResult(result);
    if (result.ok && result.block) {
      d.onWritten?.('block', result.block.block, cleanHex(result.block.data));
    }
  }

  // WRITE_PAGE goes through the SAME two-step confirmation as WRITE_BLOCK.
  async writePage(page: number, hex: string): Promise<void> {
    const d = this.deps;
    if (page <= 3) {
      d.renderPageWriteError(`Page ${page} is protected (pages 0–3) — writes refused.`);
      return;
    }
    if (hex.length !== 8) {
      d.renderPageWriteError(`Data must be exactly 8 hex chars / 4 bytes (got ${hex.length}).`);
      return;
    }
    d.clearPageWriteError();

    const confirmed = await confirmWrite({ block: page, data: hex, key: '', unit: 'page' });
    if (!confirmed) return;

    d.onLog(`WRITE_PAGE ${page} ${hex}`);
    const result = await this.deps.controller.writePage(page, hex);
    d.onResult(result);
    if (result.ok && result.page) {
      d.onWritten?.('page', result.page.page, cleanHex(result.page.data));
    }
  }
}
