export interface CardInfo {
  uid: string;
  sak: string;
  type: string;
}

export interface BlockResult {
  block: number;
  data: string;
}

export interface OpResult {
  ok: boolean;
  raw: string;
  card?: CardInfo;
  block?: BlockResult;
  blocks?: BlockResult[];
  error?: string;
}

export type ParsedResponseKind = 'ok' | 'err' | 'event' | 'data' | 'banner';

export interface ParsedResponse {
  kind: ParsedResponseKind;
  raw: string;
  payload: string;
}
