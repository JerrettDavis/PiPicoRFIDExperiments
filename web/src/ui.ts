import type {
  OpResult, CardInfo, BlockResult, PageResult, CardFamily,
  CardImage, MagicInfo, AtsInfo, ApduResult, CloneSummary,
} from './types.js';
import { capacityFor } from './format.js';

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

// ── Panel builders ──────────────────────────────────────────────────────────

function buildHeader(): HTMLElement {
  const h1 = make('h1', {});
  h1.textContent = 'RP2040 RFID Web Serial Tester';

  // Connection + card bar (always visible).
  const connectBtn = btn('connect', 'btn-connect', 'Connect', 'primary');
  const disconnectBtn = btn('disconnect', 'btn-disconnect', 'Disconnect');
  disconnectBtn.disabled = true;

  const statusDot = make('span', { id: 'statusDot', class: 'dot', 'data-testid': 'status-dot' });
  const statusText = make('span', { id: 'statusText', 'data-testid': 'status-text' });
  statusText.textContent = 'Disconnected';
  const statusSpan = make('span', { class: 'status' }, statusDot, statusText);

  // Card summary chip; contains the legacy card-type element.
  const cardTypeBadge = make('span', { id: 'cardTypeBadge', 'data-testid': 'card-type' });
  cardTypeBadge.textContent = 'No card';
  const cardSummary = make('span', { id: 'headerCardSummary', 'data-testid': 'header-card-summary', class: 'card-chip' },
    cardTypeBadge);

  // Last-operation badge lives in the always-visible header so success/fail is
  // visible regardless of the active tab.
  const opBadge = make('span', { id: 'opBadge' });

  const bar = make('div', { 'data-testid': 'header-bar', class: 'header-bar' },
    connectBtn, disconnectBtn, statusSpan, cardSummary, opBadge);

  return make('header', {}, h1, bar);
}

function buildTabbar(): HTMLElement {
  const nav = make('nav', { 'data-testid': 'tabbar', class: 'tabbar', role: 'tablist' });
  const defs: Array<[string, string]> = [
    ['read', 'Read'],
    ['edit', 'Edit'],
    ['clone', 'Clone'],
    ['identify', 'Identify'],
    ['console', 'Console'],
  ];
  for (const [id, label] of defs) {
    const b = make('button', {
      'data-tab': id,
      'data-testid': `tab-${id}`,
      role: 'tab',
      'aria-selected': 'false',
      tabindex: '-1',
    });
    b.textContent = label;
    nav.appendChild(b);
  }
  return nav;
}

function panel(id: string): HTMLElement {
  const p = make('section', { 'data-testid': `panel-${id}`, role: 'tabpanel', class: 'tabpanel' });
  p.setAttribute('hidden', '');
  return p;
}

function buildReadPanel(): HTMLElement {
  const p = panel('read');

  // Quick actions.
  const pingBtn = make('button', { 'data-cmd': 'PING', 'data-testid': 'btn-ping' });
  pingBtn.textContent = 'Ping';
  const versionBtn = make('button', { 'data-cmd': 'VERSION', 'data-testid': 'btn-version' });
  versionBtn.textContent = 'Version';
  const helpBtn = make('button', { 'data-cmd': 'HELP', 'data-testid': 'btn-help' });
  helpBtn.textContent = 'Help';
  const scanBtn = make('button', { 'data-cmd': 'SCAN', 'data-testid': 'btn-scan' });
  scanBtn.textContent = 'Scan UID';
  const quickBtns = div({ class: 'buttons' }, pingBtn, versionBtn, helpBtn, scanBtn);

  // Auto-read toggle.
  const autoReadCheckbox = make('input', { id: 'autoRead', 'data-testid': 'toggle-autoread', type: 'checkbox' });
  autoReadCheckbox.style.cssText = 'width: auto; flex: 0 0 auto; margin: 0;';
  const autoReadText = make('span', {});
  autoReadText.textContent = 'Auto-read on detect';
  const autoReadLabel = make('label', { id: 'autoReadLabel', for: 'autoRead' });
  autoReadLabel.style.cssText = 'display: flex; align-items: center; gap: 8px; margin: 12px 0 0; cursor: pointer; color: var(--text);';
  autoReadLabel.append(autoReadCheckbox, autoReadText);

  // RESCAN control.
  const rescanInput = inputEl('rescan', 'input-rescan', 'number', '0');
  rescanInput.min = '0';
  const rescanApplyBtn = btn('rescanApply', 'btn-rescan', 'Apply');
  const rescanRow = div({ class: 'row' }, rescanInput, rescanApplyBtn);

  // Read full map + hex/ascii toggle.
  const fullMapBtn = btn('readFullMap', 'btn-read-fullmap', 'Read full memory map', 'primary');
  const hexAsciiBtn = make('button', { id: 'hexAscii', 'data-testid': 'toggle-hexascii', 'aria-pressed': 'false' });
  hexAsciiBtn.textContent = 'Hex / ASCII';
  const mapBtns = div({ class: 'buttons' }, fullMapBtn, hexAsciiBtn);

  // Card data panel (legacy testid) — single read/write controls live in Edit
  // (they share the address inputs); reads render here. toContainText works on
  // this element regardless of which tab is active.
  const cardPanel = make('div', { id: 'cardPanel', class: 'card-panel empty', 'data-testid': 'card-panel' });
  cardPanel.textContent = 'No card data yet.';

  // Memory map container.
  const memmapContainer = make('div', { id: 'memmapContainer', 'data-testid': 'memmap-container', class: 'memmap-container' });

  p.append(
    make('h2', {}, 'Read'),
    quickBtns,
    autoReadLabel,
    lbl('rescan', 'Re-scan interval (ms) — 0 disables'),
    rescanRow,
    mapBtns,
    memmapContainer,
    cardPanel,
  );
  return p;
}

function buildEditPanel(): HTMLElement {
  const p = panel('edit');

  // Classic sub-group (keep classic-controls testid). Owns the canonical
  // block/key address inputs; the Read-tab single reads use these too.
  const blockInput = inputEl('block', 'input-block', 'number', '4');
  blockInput.min = '0'; blockInput.max = '255';
  const keyInput = inputEl('key', 'input-key');
  keyInput.value = 'FFFFFFFFFFFF';
  keyInput.spellcheck = false;
  const editReadBtn = btn('editRead', 'btn-edit-read', 'Read into editor');
  const readBtn = btn('readBlock', 'btn-read', 'Read Block');
  const dumpBtn = btn('dumpSector', 'btn-dump', 'Dump Sector');
  const dataArea = make('textarea', { id: 'data', 'data-testid': 'input-data' });
  dataArea.spellcheck = false;
  dataArea.textContent = '48656C6C6F2066726F6D205069636F21';
  const writeError = make('div', { id: 'writeError', class: 'inline-error', 'data-testid': 'write-error' });
  const writeBtn = btn('writeBlock', 'btn-write', 'Write Block', 'danger');

  // Inner group carries the legacy "classic-controls" testid; the outer wrapper
  // carries the new "edit-classic" testid. Both are queryable; both share the
  // same visibility (toggled on the inner group via renderCardFamily).
  const classicGroup = make('div', { id: 'classicGroup', 'data-testid': 'classic-controls' },
    make('h2', {}, 'Edit / read block (Classic)'),
    lbl('block', 'Block number'), blockInput,
    lbl('key', 'Key A hex (default: FFFFFFFFFFFF)'), keyInput,
    div({ class: 'buttons' }, readBtn, dumpBtn, editReadBtn),
    lbl('data', '16 bytes / 32 hex chars to write'), dataArea,
    writeError,
    div({ class: 'buttons' }, writeBtn),
  );
  const classicWrap = make('div', { 'data-testid': 'edit-classic' }, classicGroup);

  // UL sub-group (keep ultralight-controls testid).
  const pageInput = inputEl('page', 'input-page', 'number', '4');
  pageInput.min = '0'; pageInput.max = '255';
  const editReadPageBtn = btn('editReadPage', 'btn-edit-read-page', 'Read into editor');
  const readPageBtn = btn('readPage', 'btn-read-page', 'Read Page');
  const pageDataArea = make('textarea', { id: 'pageData', 'data-testid': 'input-page-data' });
  pageDataArea.spellcheck = false;
  pageDataArea.textContent = '48656C6C';
  pageDataArea.style.cssText = 'min-height: 44px;';
  const pageWriteError = make('div', { id: 'pageWriteError', class: 'inline-error', 'data-testid': 'page-write-error' });
  const writePageBtn = btn('writePage', 'btn-write-page', 'Write Page', 'danger');

  const ulGroup = make('div', { id: 'ultralightGroup', 'data-testid': 'ultralight-controls' },
    make('h2', {}, 'Edit / read page (Ultralight)'),
    lbl('page', 'Page number (0–3 protected)'), pageInput,
    div({ class: 'buttons' }, readPageBtn, editReadPageBtn),
    lbl('pageData', '4 bytes / 8 hex chars to write'), pageDataArea,
    pageWriteError,
    div({ class: 'buttons' }, writePageBtn),
  );
  ulGroup.style.display = 'none';
  const ulWrap = make('div', { 'data-testid': 'edit-ultralight' }, ulGroup);

  // ISO4 / unsupported note within Edit.
  const editUnsupported = make('div', { id: 'editUnsupported', 'data-testid': 'edit-unsupported' });
  editUnsupported.style.cssText = 'display: none; padding: 12px; border: 1px solid var(--border); border-radius: 10px; color: var(--muted);';
  editUnsupported.textContent = 'Block/page edit not supported for this card type.';

  p.append(classicWrap, ulWrap, editUnsupported);
  return p;
}

function buildClonePanel(): HTMLElement {
  const p = panel('clone');

  const cloneReadBtn = btn('cloneRead', 'btn-clone-read', 'Read Source');
  const cloneDetectBtn = btn('cloneDetect', 'btn-clone-detect', 'Detect Target');
  const cloneWriteBtn = btn('cloneWrite', 'btn-clone-write', 'Write Clone', 'danger');
  const cloneExportBtn = btn('cloneExport', 'btn-clone-export', 'Export JSON');
  const cloneImportBtn = btn('cloneImport', 'btn-clone-import', 'Import JSON');
  const cloneBtns = div({ class: 'buttons' }, cloneReadBtn, cloneDetectBtn, cloneWriteBtn, cloneExportBtn, cloneImportBtn);

  const cloneImportInput = make('textarea', { id: 'cloneImportInput', 'data-testid': 'input-clone-import' });
  cloneImportInput.spellcheck = false;
  cloneImportInput.style.cssText = 'min-height: 44px; font-family: ui-monospace, monospace; font-size: 12px;';
  cloneImportInput.placeholder = 'Paste exported image JSON, then click Import JSON';

  const keyDictCheckbox = make('input', { id: 'keyDict', 'data-testid': 'toggle-keydict', type: 'checkbox' });
  keyDictCheckbox.style.cssText = 'width: auto; flex: 0 0 auto; margin: 0;';
  keyDictCheckbox.checked = true;
  const keyDictText = make('span', {});
  keyDictText.textContent = 'Use key dictionary';
  const keyDictLabel = make('label', { for: 'keyDict' });
  keyDictLabel.style.cssText = 'display: flex; align-items: center; gap: 8px; margin: 10px 0 0; cursor: pointer;';
  keyDictLabel.append(keyDictCheckbox, keyDictText);
  const keyDictStatus = make('div', { id: 'keydictStatus', 'data-testid': 'keydict-status' });
  keyDictStatus.style.cssText = 'font-size: 12px; color: var(--muted); margin-top: 4px;';
  keyDictStatus.textContent = 'Dictionary: ON';

  const cloneImagePanel = make('div', { id: 'cloneImagePanel', 'data-testid': 'clone-image-panel', class: 'card-panel empty' });
  cloneImagePanel.style.cssText = 'margin-top: 12px; font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; max-height: 240px; overflow: auto;';
  cloneImagePanel.textContent = 'No source image captured.';

  const cloneTargetPanel = make('div', { id: 'cloneTargetPanel', 'data-testid': 'clone-target-panel', class: 'card-panel empty' });
  cloneTargetPanel.style.cssText = 'margin-top: 12px; font-size: 13px;';
  cloneTargetPanel.textContent = 'No target detected.';

  const cloneProgress = make('div', { id: 'cloneProgress', 'data-testid': 'clone-progress', 'data-clone-progress': '0/0' });
  cloneProgress.style.cssText = 'margin-top: 10px; font-size: 13px; color: var(--muted);';
  cloneProgress.textContent = 'Progress: 0/0';

  const cloneSummary = make('div', { id: 'cloneSummary', 'data-testid': 'clone-summary' });
  cloneSummary.style.cssText = 'margin-top: 10px; font-size: 13px;';

  const cloneGroup = make('div', { id: 'cloneGroup', 'data-testid': 'clone-panel' },
    make('h2', {}, 'Clone workflow'),
    cloneBtns,
    keyDictLabel,
    keyDictStatus,
    cloneImagePanel,
    cloneTargetPanel,
    cloneProgress,
    cloneSummary,
    cloneImportInput,
  );

  p.append(cloneGroup);
  return p;
}

function buildIdentifyPanel(): HTMLElement {
  const p = panel('identify');

  const cloneImpossible = make('div', { id: 'cloneImpossible', 'data-testid': 'clone-impossible-notice' });
  cloneImpossible.style.cssText = 'margin: 8px 0; padding: 10px; border: 1px solid var(--danger); border-radius: 10px; color: var(--danger); font-weight: 700;';
  cloneImpossible.textContent = 'Clone not possible: DESFire / EMV / phone-emulated cards cannot be cloned.';

  // Move the ISO4 unsupported-notice here.
  const unsupportedGroup = make('div', { id: 'unsupportedGroup', 'data-testid': 'unsupported-notice' });
  unsupportedGroup.style.cssText = 'margin: 8px 0; padding: 12px; border: 1px solid var(--border); border-radius: 10px; color: var(--muted);';
  unsupportedGroup.textContent = 'UID only — block/page operations not supported for this card type.';

  const idSummary = make('div', { id: 'identifySummary', 'data-testid': 'identify-summary', class: 'card-panel empty' });
  idSummary.textContent = 'No card identified.';

  const atsDisplay = make('div', { id: 'atsDisplay', 'data-testid': 'ats-display' });
  atsDisplay.style.cssText = 'margin: 8px 0; font-family: ui-monospace, monospace; font-size: 13px;';
  atsDisplay.textContent = 'ATS: (not read)';
  const atsBtn = btn('atsRead', 'btn-ats-read', 'Read ATS');

  const apduInput = inputEl('apdu', 'input-apdu');
  apduInput.placeholder = '60';
  apduInput.value = '60';
  const apduSendBtn = btn('apduSend', 'btn-apdu-send', 'Send APDU');
  const apduRow = div({ class: 'row' }, apduInput, apduSendBtn);
  const apduResponse = make('div', { id: 'apduResponse', 'data-testid': 'apdu-response' });
  apduResponse.style.cssText = 'margin-top: 8px; font-family: ui-monospace, monospace; font-size: 13px;';
  apduResponse.textContent = 'APDU response: (none)';

  const iso4Group = make('div', { id: 'iso4Group', 'data-testid': 'iso4-panel' },
    make('h2', {}, 'ISO 14443-4 identify'),
    cloneImpossible,
    unsupportedGroup,
    idSummary,
    div({ class: 'buttons' }, atsBtn),
    atsDisplay,
    lbl('apdu', 'APDU (hex)'),
    apduRow,
    apduResponse,
  );

  p.append(iso4Group);
  return p;
}

function buildConsolePanel(): HTMLElement {
  const p = panel('console');

  const rawInput = inputEl('raw', 'input-raw');
  rawInput.placeholder = 'READ_BLOCK 4';
  const sendRawBtn = btn('sendRaw', 'btn-send-raw', 'Send Raw');
  const consoleWriteError = make('div', { id: 'consoleWriteError', class: 'inline-error', 'data-testid': 'console-write-error' });

  const logEl = make('div', { id: 'log', 'data-testid': 'log' });
  const clearLogBtn = btn('clearLog', 'btn-clear-log', 'Clear');

  p.append(
    make('h2', {}, 'Console'),
    lbl('raw', 'Command'),
    rawInput,
    div({ class: 'buttons' }, sendRawBtn),
    consoleWriteError,
    make('h2', { style: 'margin-top: 22px;' }, 'Serial Log'),
    logEl,
    div({ class: 'buttons' }, clearLogBtn),
  );
  return p;
}

// ── DOM skeleton ──────────────────────────────────────────────────────────────

export function buildDOM(): void {
  const header = buildHeader();
  const tabbar = buildTabbar();
  const main = make('main', { class: 'tabbed' },
    buildReadPanel(),
    buildEditPanel(),
    buildClonePanel(),
    buildIdentifyPanel(),
    buildConsolePanel(),
  );
  document.body.append(header, tabbar, main);
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
export function getCloneImportInput(): HTMLTextAreaElement { return elById('cloneImportInput'); }
export function getKeyDictToggle(): HTMLInputElement { return elById('keyDict'); }
export function getApduInput(): HTMLInputElement { return elById('apdu'); }
export function getMemmapContainer(): HTMLElement { return elById('memmapContainer'); }
export function getHexAsciiToggle(): HTMLButtonElement { return elById('hexAscii'); }

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

/** Header card summary chip: "UID · TYPE · capacity"; keeps card-type element. */
export function renderHeaderSummary(card: CardInfo): void {
  const badge = elById('cardTypeBadge');
  const cap = capacityFor(card.type);
  const capStr = cap.family === 'CLASSIC'
    ? `${cap.totalBytes}B`
    : cap.family === 'ULTRALIGHT'
      ? `${cap.totalBytes}B`
      : '—';
  // card-type element keeps showing TYPE (CLASSIC) for legacy tests.
  badge.textContent = `${card.uid} · ${card.type} (${card.family}) · ${capStr}`;
}

export function renderCardInfo(card: CardInfo): void {
  const panel = elById('cardPanel');
  panel.classList.remove('empty');
  const sizePart = card.size ? `  SIZE: ${card.size}` : '';
  panel.textContent = `UID: ${card.uid}${sizePart}  SAK: ${card.sak}  TYPE: ${card.type}`;
  renderCardType(card);
  renderCardFamily(card.family);
  renderHeaderSummary(card);
  renderIdentifySummary(card);
}

/** Keep the legacy card-type element content (TYPE + family + UID size). */
export function renderCardType(card: CardInfo): void {
  const el = elById('cardTypeBadge');
  const sizePart = card.size ? ` · UID ${card.size}B` : '';
  el.textContent = `${card.uid} · ${card.type} (${card.family})${sizePart}`;
}

function renderIdentifySummary(card: CardInfo): void {
  const el = elById('identifySummary');
  el.classList.remove('empty');
  const atsPart = card.ats ? `  ATS: ${card.ats}` : '';
  el.textContent = `UID: ${card.uid}  TYPE: ${card.type}  FAMILY: ${card.family}${card.atqa ? `  ATQA: ${card.atqa}` : ''}${atsPart}`;
}

/** Adapt panel CONTENTS to the detected family (does NOT hide whole tabs). */
export function renderCardFamily(family: CardFamily): void {
  const isClassic = family === 'CLASSIC';
  const isUl = family === 'ULTRALIGHT';
  const isIso = family === 'ISO4' || family === 'UNKNOWN';
  // Edit tab: show the relevant editor sub-group.
  elById('classicGroup').style.display = isClassic ? '' : 'none';
  elById('ultralightGroup').style.display = isUl ? '' : 'none';
  elById('editUnsupported').style.display = isIso ? '' : 'none';
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

export function renderConsoleError(msg: string): void {
  elById('consoleWriteError').textContent = msg;
}

// ── clone workflow render helpers ──────────────────────────────────────────────

export function renderCloneImage(image: CardImage): void {
  const panel = elById('cloneImagePanel');
  panel.classList.remove('empty');
  panel.replaceChildren();

  const head = document.createElement('div');
  head.style.cssText = 'margin-bottom: 6px;';
  head.textContent = `Image: UID=${image.uid} SIZE=${image.size} TYPE=${image.type}`;
  panel.appendChild(head);

  if (image.family === 'ULTRALIGHT' && image.pages) {
    for (const p of image.pages) {
      const line = document.createElement('div');
      if (p.err) {
        line.style.color = 'var(--danger)';
        line.textContent = `PAGE ${p.page}: ERR ${p.err}`;
      } else {
        line.textContent = `PAGE ${p.page}: ${p.data}`;
      }
      panel.appendChild(line);
    }
    return;
  }

  for (const sec of image.sectors ?? []) {
    const secLine = document.createElement('div');
    secLine.style.cssText = sec.status === 'FAILED'
      ? 'color: var(--danger); font-weight: 700; margin-top: 4px;'
      : 'margin-top: 4px;';
    secLine.textContent = `SECTOR ${sec.sector} KEY=${sec.key} KEYTYPE=${sec.keyType} STATUS=${sec.status}`;
    panel.appendChild(secLine);
    for (const blk of sec.blocks) {
      const line = document.createElement('div');
      if (blk.err) {
        line.style.color = 'var(--danger)';
        line.textContent = `  BLOCK ${blk.block}: ERR ${blk.err}`;
      } else {
        line.textContent = `  BLOCK ${blk.block}: ${blk.data}`;
      }
      panel.appendChild(line);
    }
  }
}

export function renderCloneTarget(target: CardInfo, magic: MagicInfo | null, familyMatch: boolean): void {
  const panel = elById('cloneTargetPanel');
  panel.classList.remove('empty');
  panel.replaceChildren();

  const uidLine = document.createElement('div');
  uidLine.textContent = `Target UID: ${target.uid} (${target.family})`;
  panel.appendChild(uidLine);

  if (magic) {
    const magicLine = document.createElement('div');
    magicLine.textContent = `Magic: GEN=${magic.gen} METHOD=${magic.method}${magic.uidLen ? ` UIDLEN=${magic.uidLen}` : ''}`;
    panel.appendChild(magicLine);
  }

  const matchLine = document.createElement('div');
  matchLine.style.cssText = familyMatch ? 'color: var(--ok);' : 'color: var(--danger); font-weight: 700;';
  matchLine.textContent = familyMatch ? 'Family match: OK' : 'Family MISMATCH — clone blocked';
  panel.appendChild(matchLine);
}

export function renderCloneProgress(done: number, total: number): void {
  const el = elById('cloneProgress');
  el.setAttribute('data-clone-progress', `${done}/${total}`);
  el.textContent = `Progress: ${done}/${total}`;
}

export function renderCloneSummary(summary: CloneSummary): void {
  const panel = elById('cloneSummary');
  panel.replaceChildren();

  const written = document.createElement('div');
  written.textContent = `Written: ${summary.written}  Failed: ${summary.failed.length}`;
  panel.appendChild(written);

  const uid = document.createElement('div');
  uid.textContent = summary.uidCloned
    ? `UID cloned: YES (${summary.uidMethod})`
    : `UID cloned: NO (${summary.uidMethod})`;
  panel.appendChild(uid);

  for (const f of summary.failed) {
    const line = document.createElement('div');
    line.style.color = 'var(--danger)';
    line.textContent = `FAILED addr ${f.addr}: ${f.err}`;
    panel.appendChild(line);
  }
  for (const w of summary.warnings) {
    const line = document.createElement('div');
    line.style.color = 'var(--muted)';
    line.textContent = `WARN: ${w}`;
    panel.appendChild(line);
  }
}

export function renderKeyDictStatus(on: boolean): void {
  elById('keydictStatus').textContent = `Dictionary: ${on ? 'ON' : 'OFF'}`;
}

export function renderAts(ats: AtsInfo): void {
  const el = elById('atsDisplay');
  el.textContent = `ATS: ${ats.ats}${ats.histBytes ? ` HIST=${ats.histBytes}` : ''}`;
}

export function renderApduResponse(apdu: ApduResult): void {
  const el = elById('apduResponse');
  el.textContent = `APDU response: RESP=${apdu.resp || '(empty)'}${apdu.sw ? ` SW=${apdu.sw}` : ''}`;
}

export function renderCloneError(msg: string): void {
  const panel = elById('cloneSummary');
  panel.replaceChildren();
  const line = document.createElement('div');
  line.style.color = 'var(--danger)';
  line.textContent = msg;
  panel.appendChild(line);
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
