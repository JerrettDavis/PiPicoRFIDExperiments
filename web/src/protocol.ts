import type {
  ParsedResponse, CardInfo, CardFamily,
  CardImage, ImageSector, ImageBlock, ImagePage, MagicInfo, AtsInfo, ApduResult,
} from './types.js';

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

// v0.3 — clone workflow
export function buildCloneRead(): string {
  return 'CLONE_READ';
}

export function buildCloneReadUl(): string {
  return 'CLONE_READ_UL';
}

export function buildMagicDetect(): string {
  return 'MAGIC_DETECT';
}

export function buildCloneUid(block0: string, method: string): string {
  return `CLONE_UID ${cleanHex(block0)} METHOD=${method}`;
}

export function buildWriteBlockRaw(block: number, hex: string, key: string): string {
  return `WRITE_BLOCK_RAW ${block} ${cleanHex(hex)} KEY=${cleanHex(key)}`;
}

export function buildWriteTrailer(trailerBlock: number, hex: string, key: string): string {
  return `WRITE_TRAILER ${trailerBlock} ${cleanHex(hex)} KEY=${cleanHex(key)}`;
}

export function buildWritePageRaw(page: number, hex: string): string {
  return `WRITE_PAGE_RAW ${page} ${cleanHex(hex)}`;
}

export function buildAts(): string {
  return 'ATS';
}

export function buildApdu(hex: string): string {
  return `APDU ${cleanHex(hex)}`;
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
 * Parse a SCAN/UID OK payload by KEY (order-independent). v0.3 format:
 *   `UID=<hex> SIZE=<n> SAK=0x<NN> TYPE=<TOKEN> ATQA=0x<NNNN> [ATS=<hex>]`
 * Tolerates older formats (SIZE / ATQA / ATS optional).
 * Returns null if it is not a UID payload.
 */
export function parseScanPayload(payload: string): CardInfo | null {
  if (!/\bUID=/.test(payload) || !/\bSAK=/.test(payload)) return null;
  const uid = payload.match(/\bUID=(\S+)/)?.[1] ?? '';
  const sizeStr = payload.match(/\bSIZE=(\d+)/)?.[1];
  const size = sizeStr ? parseInt(sizeStr, 10) : 0;
  const sak = payload.match(/\bSAK=(\S+)/)?.[1] ?? '';
  const type = payload.match(/\bTYPE=(\S+)/)?.[1] ?? 'UNKNOWN';
  const atqa = payload.match(/\bATQA=(\S+)/)?.[1];
  const ats = payload.match(/\bATS=(\S+)/)?.[1];
  const card: CardInfo = { uid, size, sak, type, family: cardFamily(type) };
  if (atqa) card.atqa = atqa;
  if (ats) card.ats = ats;
  return card;
}

// ── v0.3: BCC + block-0 helpers ────────────────────────────────────────────────

/**
 * Classic 4-byte UID BCC = XOR of the 4 UID bytes. `uidBytes` is the UID hex
 * (8 hex chars / 4 bytes). Returns a 2-hex-char byte string.
 */
export function bccClassic(uidBytes: string): string {
  const h = cleanHex(uidBytes);
  let bcc = 0;
  for (let i = 0; i + 1 < h.length; i += 2) {
    bcc ^= parseInt(h.slice(i, i + 2), 16);
  }
  return bcc.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Derive the manufacturer block-0 (32 hex) for a captured image. If the image
 * already carries block0, return it. Otherwise, for a 4-byte UID Classic card,
 * synthesize UID(4) + BCC(1) + SAK(1) + padding to 16 bytes.
 */
export function deriveBlock0(image: CardImage): string | undefined {
  if (image.block0) return image.block0;
  // Prefer an actual sector-0 block-0 if present.
  const sec0 = image.sectors?.find(s => s.sector === 0);
  const blk0 = sec0?.blocks.find(b => b.block === 0);
  if (blk0?.data) return blk0.data;
  // Synthesize from a 4-byte UID.
  const uid = cleanHex(image.uid);
  if (uid.length === 8) {
    const bcc = bccClassic(uid);
    // Normalize SAK to a single byte: strip non-hex (drops the "0x" prefix) and
    // take the last 2 hex chars; default to 08 (MIFARE 1K) when absent.
    const sak = cleanHex(image.sak).slice(-2).padStart(2, '0') || '08';
    let b0 = uid + bcc + sak;
    b0 = (b0 + '0'.repeat(32)).slice(0, 32);
    return b0;
  }
  return undefined;
}

// ── v0.3: streaming + scalar parsers ───────────────────────────────────────────

const UNKNOWN_KEY = '------------';

/**
 * Parse a complete CLONE_READ stream into a CardImage. Handles BOTH the Classic
 * framing (CLONE_BEGIN / SECTOR / BLOCK / CLONE_END) and the Ultralight framing
 * (ULDUMP_BEGIN / PAGE / ULDUMP_END). `lines` are the raw protocol lines
 * (including the terminal OK ..._END line).
 */
export function parseCloneStream(lines: string[]): CardImage {
  const readAt = new Date().toISOString();
  // Detect framing from the BEGIN line.
  const beginLine = lines.find(l => /\b(CLONE_BEGIN|ULDUMP_BEGIN)\b/.test(l)) ?? '';
  const isUl = /\bULDUMP_BEGIN\b/.test(beginLine);

  const uid = beginLine.match(/\bUID=(\S+)/)?.[1] ?? '';
  const sizeStr = beginLine.match(/\bSIZE=(\d+)/)?.[1];
  const size = sizeStr ? parseInt(sizeStr, 10) : 0;
  const sak = beginLine.match(/\bSAK=(\S+)/)?.[1] ?? '';
  const type = beginLine.match(/\bTYPE=(\S+)/)?.[1] ?? (isUl ? 'MIFARE_UL' : 'UNKNOWN');
  const atqa = beginLine.match(/\bATQA=(\S+)/)?.[1];

  const image: CardImage = {
    uid, size, sak, type, family: cardFamily(type), readAt,
  };
  if (atqa) image.atqa = atqa;

  if (isUl) {
    const pages: ImagePage[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*PAGE=(\d+)\s+(.*)$/);
      if (!m) continue;
      const page = parseInt(m[1]!, 10);
      const rest = m[2]!;
      const dataM = rest.match(/^DATA=([0-9A-Fa-f]+)/);
      if (dataM) {
        pages.push({ page, data: dataM[1]!.toUpperCase() });
      } else {
        const errM = rest.match(/^ERR=(\S+)/);
        pages.push({ page, err: errM?.[1] ?? rest.trim() });
      }
    }
    image.pages = pages;
    return image;
  }

  // Classic framing.
  const sectors: ImageSector[] = [];
  let cur: ImageSector | null = null;
  for (const line of lines) {
    const secM = line.match(/^\s*SECTOR=(\d+)\s+(.*)$/);
    if (secM) {
      const sector = parseInt(secM[1]!, 10);
      const rest = secM[2]!;
      const key = rest.match(/\bKEY=(\S+)/)?.[1] ?? UNKNOWN_KEY;
      const keyTypeRaw = rest.match(/\bKEYTYPE=(\S+)/)?.[1] ?? 'NONE';
      const keyType = (keyTypeRaw === 'A' || keyTypeRaw === 'B') ? keyTypeRaw : 'NONE';
      const statusRaw = rest.match(/\bSTATUS=(\S+)/)?.[1] ?? 'FAILED';
      const status = statusRaw === 'OK' ? 'OK' : 'FAILED';
      cur = { sector, key, keyType, status, blocks: [] };
      sectors.push(cur);
      continue;
    }
    const blkM = line.match(/^\s*BLOCK=(\d+)\s+(.*)$/);
    if (blkM && cur) {
      const block = parseInt(blkM[1]!, 10);
      const rest = blkM[2]!;
      const dataM = rest.match(/^DATA=([0-9A-Fa-f]+)/);
      const blk: ImageBlock = { block };
      if (dataM) blk.data = dataM[1]!.toUpperCase();
      else blk.err = rest.match(/^ERR=(\S+)/)?.[1] ?? rest.trim();
      cur.blocks.push(blk);
    }
  }
  image.sectors = sectors;
  const b0 = deriveBlock0(image);
  if (b0) image.block0 = b0;
  return image;
}

/** Parse `MAGIC TYPE=.. GEN=.. METHOD=.. [UIDLEN=..]`. */
export function parseMagic(payload: string): MagicInfo {
  const typeTok = payload.match(/\bTYPE=(\S+)/)?.[1] ?? 'UNKNOWN';
  const family: CardFamily =
    typeTok === 'CLASSIC' ? 'CLASSIC' : typeTok === 'ULTRALIGHT' ? 'ULTRALIGHT' : 'UNKNOWN';
  const gen = payload.match(/\bGEN=(\S+)/)?.[1] ?? 'NORMAL';
  const method = payload.match(/\bMETHOD=(\S+)/)?.[1] ?? 'NONE';
  const uidLenStr = payload.match(/\bUIDLEN=(\d+)/)?.[1];
  const info: MagicInfo = { family, gen, method };
  if (uidLenStr) info.uidLen = parseInt(uidLenStr, 10);
  return info;
}

/** Parse `ATS=<hex> HISTBYTES=<hex|->`. */
export function parseAts(payload: string): AtsInfo {
  const ats = payload.match(/\bATS=(\S+)/)?.[1] ?? '';
  const hist = payload.match(/\bHISTBYTES=(\S+)/)?.[1];
  const info: AtsInfo = { ats };
  if (hist && hist !== '-') info.histBytes = hist;
  return info;
}

/** Parse `APDU RESP=<hex> SW=<hex4|->`. */
export function parseApdu(payload: string): ApduResult {
  const resp = payload.match(/\bRESP=(\S+)/)?.[1] ?? '';
  const sw = payload.match(/\bSW=(\S+)/)?.[1];
  const result: ApduResult = { resp };
  if (sw && sw !== '-') result.sw = sw;
  return result;
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
  if (trimmed.startsWith('BLOCK=') || trimmed.startsWith('SECTOR=') || trimmed.startsWith('PAGE=')) {
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
