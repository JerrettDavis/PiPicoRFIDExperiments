export type CardFamily = 'CLASSIC' | 'ULTRALIGHT' | 'ISO4' | 'UNKNOWN';

export interface CardInfo {
  uid: string;
  /** UID byte size: 4 | 7 | 10 (may be 0 if not reported). */
  size: number;
  sak: string;
  /** Raw TYPE token from firmware (e.g. MIFARE_1K, MIFARE_UL, ISO_14443_4). */
  type: string;
  /** Derived family for UI behavior. */
  family: CardFamily;
  /** ATQA (v0.3), e.g. 0x0004. Optional. */
  atqa?: string;
  /** ATS hex (v0.3) — present only for ISO4 cards. Optional. */
  ats?: string;
}

// ── v0.3: clone workflow ──────────────────────────────────────────────────────

export interface ImageBlock {
  block: number;
  data?: string;
  err?: string;
}

export interface ImageSector {
  sector: number;
  /** Recovered Key A/B hex (12) or '------------' when unknown. */
  key: string;
  keyType: 'A' | 'B' | 'NONE';
  status: 'OK' | 'FAILED';
  blocks: ImageBlock[];
}

export interface ImagePage {
  page: number;
  data?: string;
  err?: string;
}

/** A captured source-card image produced by CLONE_READ / CLONE_READ_UL. */
export interface CardImage {
  uid: string;
  size: number;
  sak: string;
  type: string;
  family: CardFamily;
  atqa?: string;
  /** Classic sectors (present for CLASSIC images). */
  sectors?: ImageSector[];
  /** Ultralight pages (present for ULTRALIGHT images). */
  pages?: ImagePage[];
  /** Derived block-0 (manufacturer block) hex, for UID cloning. */
  block0?: string;
  /** ISO-8601 capture timestamp. */
  readAt: string;
}

export interface MagicInfo {
  family: CardFamily;
  /** Classic: GEN1A|GEN2|NORMAL. UL: MAGIC|NORMAL. */
  gen: string;
  /** BACKDOOR|DIRECT|NONE. */
  method: string;
  /** Classic only: 4|7. */
  uidLen?: number;
}

export interface CloneFailure {
  /** Block or page address that failed. */
  addr: number;
  err: string;
}

export interface CloneSummary {
  /** Count of blocks/pages successfully written. */
  written: number;
  failed: CloneFailure[];
  uidCloned: boolean;
  /** GEN1A|GEN2 when cloned, or a reason token when not. */
  uidMethod: string;
  warnings: string[];
}

export interface AtsInfo {
  ats: string;
  histBytes?: string;
}

export interface ApduResult {
  resp: string;
  sw?: string;
}

export interface BlockResult {
  block: number;
  data: string;
}

export interface PageResult {
  page: number;
  data: string;
}

export interface OpResult {
  ok: boolean;
  raw: string;
  card?: CardInfo;
  block?: BlockResult;
  blocks?: BlockResult[];
  page?: PageResult;
  /** Re-scan interval (ms) confirmed by the firmware, when this op was a RESCAN. */
  rescan?: number;
  /** Captured card image (CLONE_READ / CLONE_READ_UL). */
  image?: CardImage;
  /** Magic-card detection result (MAGIC_DETECT). */
  magic?: MagicInfo;
  /** ATS info (ATS command). */
  ats?: AtsInfo;
  /** APDU exchange result (APDU command). */
  apdu?: ApduResult;
  /** Buzzer state confirmed by the firmware (BUZZER command/query). */
  buzzer?: { enabled: boolean };
  /** Beep parameters confirmed by the firmware (BEEP command). */
  beep?: { freq: number; ms: number };
  /** On-detect beep config confirmed by the firmware (BEEPCFG command/query). */
  beepCfg?: { freq: number; ms: number };
  error?: string;
}

export type ParsedResponseKind = 'ok' | 'err' | 'event' | 'data' | 'banner';

export interface ParsedResponse {
  kind: ParsedResponseKind;
  raw: string;
  payload: string;
}
