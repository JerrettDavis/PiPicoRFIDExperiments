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
  error?: string;
}

export type ParsedResponseKind = 'ok' | 'err' | 'event' | 'data' | 'banner';

export interface ParsedResponse {
  kind: ParsedResponseKind;
  raw: string;
  payload: string;
}
