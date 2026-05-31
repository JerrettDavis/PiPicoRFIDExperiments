import type { ParsedResponse } from './types.js';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

export function cleanHex(s: string): string {
  return s.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

export function sectorRange(block: number): { start: number; end: number } {
  const start = Math.floor(block / 4) * 4;
  return { start, end: start + 3 };
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
