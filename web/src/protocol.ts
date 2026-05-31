import type { ParsedResponse, CardInfo, CardFamily } from './types.js';

// ── Command builders ──────────────────────────────────────────────────────────

export function buildPing(): string {
  return 'PING';
}

export function buildVersion(): string {
  return 'VERSION';
}

export function buildHelp(): string {
  return 'HELP';
}

export function buildScan(): string {
  return 'SCAN';
}

export function buildReadBlock(block: number, key?: string): string {
  const k = key ? ` ${key}` : '';
  return `READ_BLOCK ${block}${k}`;
}

export function buildWriteBlock(block: number, hex: string, key?: string): string {
  const k = key ? ` ${key}` : '';
  return `WRITE_BLOCK ${block} ${hex}${k}`;
}

export function buildDump(start: number, end: number, key?: string): string {
  const k = key ? ` ${key}` : '';
  return `DUMP ${start} ${end}${k}`;
}

// v0.2 — Ultralight/NTAG page ops
export function buildReadPage(page: number): string {
  return `READ_PAGE ${page}`;
}

export function buildWritePage(page: number, hex: string): string {
  return `WRITE_PAGE ${page} ${hex}`;
}

// v0.2 — configurable re-scan interval
export function buildRescan(ms: number): string {
  return `RESCAN ${ms}`;
}

export function buildRescanQuery(): string {
  return 'RESCAN';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function cleanHex(s: string): string {
  return s.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/**
 * Sector block range for a given block, mirroring MIFARE Classic geometry.
 * Blocks < 128: 4-block sectors. Blocks >= 128 (4K upper area): 16-block sectors.
 */
export function sectorRange(block: number): { start: number; end: number } {
  if (block < 128) {
    const start = Math.floor(block / 4) * 4;
    return { start, end: start + 3 };
  }
  const start = 128 + Math.floor((block - 128) / 16) * 16;
  return { start, end: start + 15 };
}

/**
 * The sector-trailer block index for the sector containing `block`, mirroring
 * the firmware. Blocks < 128: trailer is the 4th block of the 4-block sector.
 * Blocks >= 128 (4K): trailer is the 16th block of the 16-block sector.
 */
export function trailerForBlock(block: number): number {
  if (block < 128) return Math.floor(block / 4) * 4 + 3;
  const sectorStart = 128 + Math.floor((block - 128) / 16) * 16;
  return sectorStart + 15;
}

/** Derive a UI "family" from a firmware TYPE token. */
export function cardFamily(type: string): CardFamily {
  switch (type) {
    case 'MIFARE_MINI':
    case 'MIFARE_1K':
    case 'MIFARE_4K':
    case 'MIFARE_PLUS':
      return 'CLASSIC';
    case 'MIFARE_UL':
      return 'ULTRALIGHT';
    case 'ISO_14443_4':
    case 'ISO_18092':
      return 'ISO4';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Parse a SCAN/UID OK payload by KEY (order-independent). v0.2 format:
 *   `UID=<hex> SIZE=<4|7|10> SAK=0x<NN> TYPE=<TOKEN>`
 * Tolerates the older format with no SIZE (size defaults to 0).
 * Returns null if it is not a UID payload.
 */
export function parseScanPayload(payload: string): CardInfo | null {
  if (!/\bUID=/.test(payload) || !/\bSAK=/.test(payload)) return null;
  const uid = payload.match(/\bUID=(\S+)/)?.[1] ?? '';
  const sizeStr = payload.match(/\bSIZE=(\d+)/)?.[1];
  const size = sizeStr ? parseInt(sizeStr, 10) : 0;
  const sak = payload.match(/\bSAK=(\S+)/)?.[1] ?? '';
  const type = payload.match(/\bTYPE=(\S+)/)?.[1] ?? 'UNKNOWN';
  return { uid, size, sak, type, family: cardFamily(type) };
}

// ── Line parser ───────────────────────────────────────────────────────────────

export function parseLine(line: string): ParsedResponse {
  const trimmed = line.trim();

  if (trimmed.startsWith('OK ') || trimmed === 'OK') {
    return { kind: 'ok', raw: line, payload: trimmed.slice(3) };
  }
  if (trimmed.startsWith('ERR ') || trimmed === 'ERR') {
    return { kind: 'err', raw: line, payload: trimmed.slice(4) };
  }
  if (trimmed.startsWith('EVENT ')) {
    return { kind: 'event', raw: line, payload: trimmed.slice(6) };
  }
  if (trimmed.startsWith('BLOCK=')) {
    return { kind: 'data', raw: line, payload: trimmed };
  }
  if (trimmed.startsWith('READY') || trimmed.startsWith('PINS ')) {
    return { kind: 'banner', raw: line, payload: trimmed };
  }
  // fallback
  return { kind: 'banner', raw: line, payload: trimmed };
}

export function isOk(r: ParsedResponse): boolean {
  return r.kind === 'ok';
}

export function isErr(r: ParsedResponse): boolean {
  return r.kind === 'err';
}

export function isEvent(r: ParsedResponse): boolean {
  return r.kind === 'event';
}
