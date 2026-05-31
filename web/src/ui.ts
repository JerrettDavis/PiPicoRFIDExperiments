import type { OpResult, CardInfo, BlockResult } from './types.js';

// ── DOM builder helpers ───────────────────────────────────────────────────────

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const child of children) {
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

function btn(id: string, testid: string, text: string, cls?: string): HTMLButtonElement {
  const b = make('button', { id, 'data-testid': testid });
  if (cls) b.className = cls;
  b.textContent = text;
  return b;
}

function inputEl(id: string, testid: string, type = 'text', value = ''): HTMLInputElement {
  const i = make('input', { id, 'data-testid': testid, type });
  i.value = value;
  return i;
}

function lbl(forId: string, text: string): HTMLLabelElement {
  const l = make('label', { for: forId });
  l.textContent = text;
  return l;
}

function div(...attrs: [Record<string, string>, ...Array<Node | string>]): HTMLDivElement {
  const [a, ...children] = attrs;
  return make('div', a, ...children);
}

// ── DOM skeleton ──────────────────────────────────────────────────────────────

export function buildDOM(): void {
  // ── Header ──────────────────────────────────────────────────────────────
  const h1 = make('h1', {});
  h1.textContent = 'RP2040 RFID Web Serial Tester';
  const subtitle = make('p', {});
  subtitle.textContent = 'Connect to the Pico firmware, scan a card, read blocks, and write safe data blocks on MIFARE Classic-style cards.';
  const header = make('header', {}, h1, subtitle);

  // ── Left panel ───────────────────────────────────────────────────────────
  const connectBtn = btn('connect', 'btn-connect', 'Connect', 'primary');
  const disconnectBtn = btn('disconnect', 'btn-disconnect', 'Disconnect');
  disconnectBtn.disabled = true;

  const statusDot = make('span', { id: 'statusDot', class: 'dot', 'data-testid': 'status-dot' });
  const statusText = make('span', { id: 'statusText', 'data-testid': 'status-text' });
  statusText.textContent = 'Disconnected';
  const statusSpan = make('span', { class: 'status' }, statusDot, statusText);
  const statusP = make('p', { style: 'margin-top: 10px;' }, statusSpan);

  const connRow = div({ class: 'row' }, connectBtn, disconnectBtn);

  const pingBtn = make('button', { 'data-cmd': 'PING', 'data-testid': 'btn-ping' });
  pingBtn.textContent = 'Ping';
  const versionBtn = make('button', { 'data-cmd': 'VERSION', 'data-testid': 'btn-version' });
  versionBtn.textContent = 'Version';
  const helpBtn = make('button', { 'data-cmd': 'HELP', 'data-testid': 'btn-help' });
  helpBtn.textContent = 'Help';
  const scanBtn = make('button', { 'data-cmd': 'SCAN', 'data-testid': 'btn-scan' });
  scanBtn.textContent = 'Scan UID';
  const quickBtns = div({ class: 'buttons' }, pingBtn, versionBtn, helpBtn, scanBtn);

  const cardPanel = make('div', { id: 'cardPanel', class: 'card-panel empty', 'data-testid': 'card-panel' });
  cardPanel.textContent = 'No card data yet.';

  const rwHeading = make('h2', { style: 'margin-top: 22px;' });
  rwHeading.textContent = 'Read / Write';

  const blockInput = inputEl('block', 'input-block', 'number', '4');
  blockInput.min = '0';
  blockInput.max = '255';

  const keyInput = inputEl('key', 'input-key');
  (keyInput as HTMLInputElement).value = 'FFFFFFFFFFFF';
  (keyInput as HTMLInputElement).spellcheck = false;

  const readBtn = btn('readBlock', 'btn-read', 'Read Block');
  const dumpBtn = btn('dumpSector', 'btn-dump', 'Dump Sector');
  const rwBtns = div({ class: 'buttons' }, readBtn, dumpBtn);
  const opBadge = div({ id: 'opBadge' });

  const dataArea = make('textarea', { id: 'data', 'data-testid': 'input-data' });
  dataArea.spellcheck = false;
  dataArea.textContent = '48656C6C6F2066726F6D205069636F21';

  const writeError = make('div', { id: 'writeError', class: 'inline-error', 'data-testid': 'write-error' });
  const writeBtn = btn('writeBlock', 'btn-write', 'Write Block', 'danger');
  const writeBtns = div({ class: 'buttons' }, writeBtn);

  const rawHeading = make('h2', { style: 'margin-top: 22px;' });
  rawHeading.textContent = 'Raw command';
  const rawInput = inputEl('raw', 'input-raw');
  (rawInput as HTMLInputElement).placeholder = 'READ_BLOCK 4';
  const sendRawBtn = btn('sendRaw', 'btn-send-raw', 'Send Raw');
  const rawBtns = div({ class: 'buttons' }, sendRawBtn);

  const leftSection = make('section', {},
    make('h2', {}, document.createTextNode('Connection')),
    connRow,
    statusP,
    quickBtns,
    cardPanel,
    rwHeading,
    lbl('block', 'Block number'),
    blockInput,
    lbl('key', 'Key A hex (default: FFFFFFFFFFFF)'),
    keyInput,
    rwBtns,
    opBadge,
    lbl('data', '16 bytes / 32 hex chars to write'),
    dataArea,
    writeError,
    writeBtns,
    rawHeading,
    lbl('raw', 'Command'),
    rawInput,
    rawBtns,
  );

  // ── Right panel (log) ────────────────────────────────────────────────────
  const logEl = make('div', { id: 'log', 'data-testid': 'log' });
  const clearLogBtn = btn('clearLog', 'btn-clear-log', 'Clear');
  const logBtns = div({ class: 'buttons' }, clearLogBtn);

  const logHeading = make('h2', {});
  logHeading.textContent = 'Serial Log';
  const rightSection = make('section', {}, logHeading, logEl, logBtns);

  // ── Assemble ─────────────────────────────────────────────────────────────
  const mainEl = make('main', {}, leftSection, rightSection);
  document.body.append(header, mainEl);
}

// ── Typed element accessors ───────────────────────────────────────────────────

function elById<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Element #${id} not found`);
  return e as T;
}

export function getConnectBtn(): HTMLButtonElement { return elById('connect'); }
export function getDisconnectBtn(): HTMLButtonElement { return elById('disconnect'); }
export function getBlockInput(): HTMLInputElement { return elById('block'); }
export function getKeyInput(): HTMLInputElement { return elById('key'); }
export function getDataInput(): HTMLTextAreaElement { return elById('data'); }
export function getRawInput(): HTMLInputElement { return elById('raw'); }
export function getLogEl(): HTMLElement { return elById('log'); }

// ── Render helpers ────────────────────────────────────────────────────────────

export function renderStatus(connected: boolean): void {
  elById('statusDot').classList.toggle('connected', connected);
  elById('statusText').textContent = connected ? 'Connected' : 'Disconnected';
  elById<HTMLButtonElement>('connect').disabled = connected;
  elById<HTMLButtonElement>('disconnect').disabled = !connected;
}

export function renderCardInfo(card: CardInfo): void {
  const panel = elById('cardPanel');
  panel.classList.remove('empty');
  panel.textContent = `UID: ${card.uid}  SAK: ${card.sak}  TYPE: ${card.type}`;
}

export function renderBlockData(blockResult: BlockResult): void {
  const panel = elById('cardPanel');
  panel.classList.remove('empty');
  const existing = panel.textContent ?? '';
  const lines = existing.split('\n').filter(l => !l.startsWith(`BLOCK ${blockResult.block}:`));
  panel.textContent = [...lines, `BLOCK ${blockResult.block}: ${blockResult.data}`].join('\n');
}

export function renderOpResult(result: OpResult): void {
  const badge = elById('opBadge');
  badge.replaceChildren();
  const span = document.createElement('span');
  span.className = `badge ${result.ok ? 'success' : 'fail'}`;
  span.setAttribute('data-testid', result.ok ? 'badge-success' : 'badge-fail');
  span.textContent = result.ok ? 'OK' : 'FAIL';
  badge.appendChild(span);

  if (result.ok) {
    if (result.card) renderCardInfo(result.card);
    if (result.block) renderBlockData(result.block);
    if (result.blocks) result.blocks.forEach(b => renderBlockData(b));
  }
}

export function renderWriteError(msg: string): void {
  elById('writeError').textContent = msg;
}

export function clearWriteError(): void {
  elById('writeError').textContent = '';
}

export function appendLog(line: string, kind: 'tx' | 'rx' | 'info' = 'info'): void {
  const logEl = elById('log');
  const prefix = kind === 'tx' ? '> ' : kind === 'rx' ? '< ' : '';
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${prefix}${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

export function clearLog(): void {
  elById('log').textContent = '';
}
