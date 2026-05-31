import type { OpResult, CardInfo, BlockResult, PageResult, CardFamily } from './types.js';

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

  // Re-scan interval control (v0.2)
  const rescanInput = inputEl('rescan', 'input-rescan', 'number', '0');
  rescanInput.min = '0';
  const rescanApplyBtn = btn('rescanApply', 'btn-rescan', 'Apply');
  const rescanRow = div({ class: 'row' }, rescanInput, rescanApplyBtn);

  const cardPanel = make('div', { id: 'cardPanel', class: 'card-panel empty', 'data-testid': 'card-panel' });
  cardPanel.textContent = 'No card data yet.';

  // Detected card type / family indicator
  const cardTypeBadge = make('div', { id: 'cardTypeBadge', 'data-testid': 'card-type', class: 'card-type' });
  cardTypeBadge.style.cssText = 'margin-top: 10px; font-size: 13px; color: var(--muted);';
  cardTypeBadge.textContent = 'No card detected';

  // ── CLASSIC controls (block / key) ───────────────────────────────────────
  const classicHeading = make('h2', { id: 'classicHeading', style: 'margin-top: 22px;' });
  classicHeading.textContent = 'Read / Write (Classic — blocks)';

  const blockInput = inputEl('block', 'input-block', 'number', '4');
  blockInput.min = '0';
  blockInput.max = '255';

  const keyInput = inputEl('key', 'input-key');
  (keyInput as HTMLInputElement).value = 'FFFFFFFFFFFF';
  (keyInput as HTMLInputElement).spellcheck = false;

  const readBtn = btn('readBlock', 'btn-read', 'Read Block');
  const dumpBtn = btn('dumpSector', 'btn-dump', 'Dump Sector');
  const rwBtns = div({ class: 'buttons' }, readBtn, dumpBtn);

  const dataArea = make('textarea', { id: 'data', 'data-testid': 'input-data' });
  dataArea.spellcheck = false;
  dataArea.textContent = '48656C6C6F2066726F6D205069636F21';

  const writeError = make('div', { id: 'writeError', class: 'inline-error', 'data-testid': 'write-error' });
  const writeBtn = btn('writeBlock', 'btn-write', 'Write Block', 'danger');
  const writeBtns = div({ class: 'buttons' }, writeBtn);

  const classicBlockLbl = lbl('block', 'Block number');
  const classicKeyLbl = lbl('key', 'Key A hex (default: FFFFFFFFFFFF)');
  const classicDataLbl = lbl('data', '16 bytes / 32 hex chars to write');
  const classicGroup = make('div', { id: 'classicGroup', 'data-testid': 'classic-controls' },
    classicHeading,
    classicBlockLbl, blockInput,
    classicKeyLbl, keyInput,
    rwBtns,
    classicDataLbl, dataArea,
    writeError,
    writeBtns,
  );

  // ── ULTRALIGHT controls (page) ───────────────────────────────────────────
  const ulHeading = make('h2', { style: 'margin-top: 22px;' });
  ulHeading.textContent = 'Read / Write (Ultralight — pages)';

  const pageInput = inputEl('page', 'input-page', 'number', '4');
  pageInput.min = '0';
  pageInput.max = '255';

  const readPageBtn = btn('readPage', 'btn-read-page', 'Read Page');
  const ulReadBtns = div({ class: 'buttons' }, readPageBtn);

  const pageDataArea = make('textarea', { id: 'pageData', 'data-testid': 'input-page-data' });
  pageDataArea.spellcheck = false;
  pageDataArea.textContent = '48656C6C';
  pageDataArea.style.cssText = 'min-height: 44px;';

  const pageWriteError = make('div', { id: 'pageWriteError', class: 'inline-error', 'data-testid': 'page-write-error' });
  const writePageBtn = btn('writePage', 'btn-write-page', 'Write Page', 'danger');
  const ulWriteBtns = div({ class: 'buttons' }, writePageBtn);

  const ulGroup = make('div', { id: 'ultralightGroup', 'data-testid': 'ultralight-controls' },
    ulHeading,
    lbl('page', 'Page number (0–3 protected)'),
    pageInput,
    ulReadBtns,
    lbl('pageData', '4 bytes / 8 hex chars to write'),
    pageDataArea,
    pageWriteError,
    ulWriteBtns,
  );
  ulGroup.style.display = 'none';

  // ── UNSUPPORTED (ISO4 / UNKNOWN) notice ──────────────────────────────────
  const unsupportedGroup = make('div', { id: 'unsupportedGroup', 'data-testid': 'unsupported-notice' });
  unsupportedGroup.style.cssText = 'display: none; margin-top: 22px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; color: var(--muted);';
  unsupportedGroup.textContent = 'UID only — block/page operations not supported for this card type.';

  // Auto-read toggle (near the action buttons)
  const autoReadCheckbox = make('input', { id: 'autoRead', 'data-testid': 'toggle-autoread', type: 'checkbox' });
  autoReadCheckbox.style.cssText = 'width: auto; flex: 0 0 auto; margin: 0;';
  const autoReadText = make('span', {});
  autoReadText.textContent = 'Auto-read on detect';
  const autoReadLabel = make('label', { id: 'autoReadLabel', for: 'autoRead' });
  autoReadLabel.style.cssText = 'display: flex; align-items: center; gap: 8px; margin: 16px 0 0; cursor: pointer; color: var(--text);';
  autoReadLabel.append(autoReadCheckbox, autoReadText);

  const opBadge = div({ id: 'opBadge' });

  const rawHeading = make('h2', { style: 'margin-top: 22px;' });
  rawHeading.textContent = 'Raw command';
  const rawInput = inputEl('raw', 'input-raw');
  (rawInput as HTMLInputElement).placeholder = 'READ_BLOCK 4';
  const sendRawBtn = btn('sendRaw', 'btn-send-raw', 'Send Raw');
  const rawBtns = div({ class: 'buttons' }, sendRawBtn);

  const rescanLbl = lbl('rescan', 'Re-scan interval (ms) — 0 disables');

  const leftSection = make('section', {},
    make('h2', {}, document.createTextNode('Connection')),
    connRow,
    statusP,
    rescanLbl,
    rescanRow,
    quickBtns,
    autoReadLabel,
    cardPanel,
    cardTypeBadge,
    opBadge,
    classicGroup,
    ulGroup,
    unsupportedGroup,
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
export function getPageInput(): HTMLInputElement { return elById('page'); }
export function getPageDataInput(): HTMLTextAreaElement { return elById('pageData'); }
export function getRescanInput(): HTMLInputElement { return elById('rescan'); }
export function getRawInput(): HTMLInputElement { return elById('raw'); }
export function getAutoReadToggle(): HTMLInputElement { return elById('autoRead'); }
export function getLogEl(): HTMLElement { return elById('log'); }

// Reflect the auto-read toggle state visually (highlight the label when ON).
export function renderAutoReadState(on: boolean): void {
  const label = elById('autoReadLabel');
  label.style.color = on ? 'var(--accent)' : 'var(--text)';
  label.style.fontWeight = on ? '650' : '400';
}

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
  const sizePart = card.size ? `  SIZE: ${card.size}` : '';
  panel.textContent = `UID: ${card.uid}${sizePart}  SAK: ${card.sak}  TYPE: ${card.type}`;
  renderCardType(card);
  renderCardFamily(card.family);
}

/** Show the detected TYPE + UID SIZE prominently, plus the derived family. */
export function renderCardType(card: CardInfo): void {
  const el = elById('cardTypeBadge');
  const sizePart = card.size ? ` · UID ${card.size}B` : '';
  el.textContent = `Detected: ${card.type} (${card.family})${sizePart}`;
}

/** Show only the controls relevant to the detected card family. */
export function renderCardFamily(family: CardFamily): void {
  elById('classicGroup').style.display = family === 'CLASSIC' ? '' : 'none';
  elById('ultralightGroup').style.display = family === 'ULTRALIGHT' ? '' : 'none';
  elById('unsupportedGroup').style.display =
    family === 'ISO4' || family === 'UNKNOWN' ? '' : 'none';
}

export function renderBlockData(blockResult: BlockResult): void {
  const panel = elById('cardPanel');
  panel.classList.remove('empty');
  const existing = panel.textContent ?? '';
  const lines = existing.split('\n').filter(l => !l.startsWith(`BLOCK ${blockResult.block}:`));
  panel.textContent = [...lines, `BLOCK ${blockResult.block}: ${blockResult.data}`].join('\n');
}

export function renderPageData(pageResult: PageResult): void {
  const panel = elById('cardPanel');
  panel.classList.remove('empty');
  const existing = panel.textContent ?? '';
  const lines = existing.split('\n').filter(l => !l.startsWith(`PAGE ${pageResult.page}:`));
  panel.textContent = [...lines, `PAGE ${pageResult.page}: ${pageResult.data}`].join('\n');
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
    if (result.page) renderPageData(result.page);
  } else if (result.error) {
    // Surface ERR (e.g. WRONG_CARD_TYPE / UNSUPPORTED_CARD / REFUSE_PAGE) in the panel.
    const panel = elById('cardPanel');
    panel.classList.remove('empty');
    const existing = panel.textContent ?? '';
    const lines = existing.split('\n').filter(l => !l.startsWith('ERR:'));
    panel.textContent = [...lines, `ERR: ${result.error}`].join('\n');
  }
}

export function renderWriteError(msg: string): void {
  elById('writeError').textContent = msg;
}

export function clearWriteError(): void {
  elById('writeError').textContent = '';
}

export function renderPageWriteError(msg: string): void {
  elById('pageWriteError').textContent = msg;
}

export function clearPageWriteError(): void {
  elById('pageWriteError').textContent = '';
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
