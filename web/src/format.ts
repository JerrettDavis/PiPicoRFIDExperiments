import { cleanHex } from './protocol.js';
import type { CardImage } from './types.js';

export type ViewMode = 'hex' | 'ascii';

const VIEW_KEY = 'rfid.viewMode';

export function getViewMode(): ViewMode {
  try {
    const v = sessionStorage.getItem(VIEW_KEY);
    if (v === 'ascii') return 'ascii';
  } catch { /* ignore */ }
  return 'hex';
}

export function setViewMode(mode: ViewMode): void {
  try { sessionStorage.setItem(VIEW_KEY, mode); } catch { /* ignore */ }
}

/** "4865" → "48 65" (space-grouped bytes). */
export function hexGrouped(hex: string): string {
  const h = cleanHex(hex);
  const out: string[] = [];
  for (let i = 0; i + 1 < h.length; i += 2) out.push(h.slice(i, i + 2));
  // Handle odd trailing nibble defensively.
  if (h.length % 2 === 1) out.push(h.slice(-1));
  return out.join(' ');
}

/** Hex bytes → ASCII; bytes < 0x20 or > 0x7E render as '.'. */
export function hexToAscii(hex: string): string {
  const h = cleanHex(hex);
  let out = '';
  for (let i = 0; i + 1 < h.length; i += 2) {
    const byte = parseInt(h.slice(i, i + 2), 16);
    out += (byte < 0x20 || byte > 0x7e) ? '.' : String.fromCharCode(byte);
  }
  return out;
}

/** True if `hex` (after cleaning) is exactly `n` hex chars. */
export function isHexLen(hex: string, n: number): boolean {
  return cleanHex(hex).length === n;
}

/** Wrap cleanHex for callers that want a normalize entry point. */
export function normalizeHex(s: string): string {
  return cleanHex(s);
}

export interface Capacity {
  family: 'CLASSIC' | 'ULTRALIGHT' | 'ISO4' | 'UNKNOWN';
  sectors?: number;
  blocks?: number;
  pages?: number;
  totalBytes: number;
}

/** Static capacity for a firmware TYPE token. */
export function capacityFor(type: string): Capacity {
  switch (type) {
    case 'MIFARE_MINI':
      return { family: 'CLASSIC', sectors: 5, blocks: 20, totalBytes: 320 };
    case 'MIFARE_1K':
    case 'MIFARE_PLUS':
      return { family: 'CLASSIC', sectors: 16, blocks: 64, totalBytes: 1024 };
    case 'MIFARE_4K':
      return { family: 'CLASSIC', sectors: 40, blocks: 256, totalBytes: 4096 };
    case 'MIFARE_UL':
      // NTAG/UL: fall back to the dump's PAGES at render time; default to UL 16/64B.
      return { family: 'ULTRALIGHT', pages: 16, totalBytes: 64 };
    case 'ISO_14443_4':
    case 'ISO_18092':
      return { family: 'ISO4', totalBytes: 0 };
    default:
      return { family: 'UNKNOWN', totalBytes: 0 };
  }
}

export interface Coverage {
  unitsTotal: number;
  unitsRead: number;
  unitsFailed: number;
  sectorsOk?: number;
  sectorsFailed?: number;
}

/** Compute read/failed coverage of a captured image against its capacity. */
export function coverageOf(image: CardImage, cap: Capacity): Coverage {
  if (image.family === 'ULTRALIGHT' || image.pages) {
    const pages = image.pages ?? [];
    const unitsTotal = cap.pages ?? pages.length;
    let unitsRead = 0;
    let unitsFailed = 0;
    for (const p of pages) {
      if (p.data !== undefined) unitsRead++;
      else if (p.err) unitsFailed++;
    }
    return { unitsTotal, unitsRead, unitsFailed };
  }

  // Classic.
  const sectors = image.sectors ?? [];
  const unitsTotal = cap.blocks ?? sectors.reduce((n, s) => n + s.blocks.length, 0);
  let unitsRead = 0;
  let unitsFailed = 0;
  let sectorsOk = 0;
  let sectorsFailed = 0;
  for (const sec of sectors) {
    if (sec.status === 'FAILED') sectorsFailed++; else sectorsOk++;
    for (const blk of sec.blocks) {
      if (blk.data !== undefined) unitsRead++;
      else if (blk.err) unitsFailed++;
    }
  }
  return { unitsTotal, unitsRead, unitsFailed, sectorsOk, sectorsFailed };
}
