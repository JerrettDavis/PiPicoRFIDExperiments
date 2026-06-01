import './style.css';
import { createTransport } from './serial/transport.js';
import { MockSerialTransport, type MockCardKind } from './serial/mockPico.js';
import { RfidController } from './controller.js';
import { CloneController } from './clone.js';
import { EditController } from './edit.js';
import { createTabs, type TabId } from './tabs.js';
import { cleanHex } from './protocol.js';
import { AutoReader } from './autoread.js';
import {
  getViewMode, setViewMode, type ViewMode,
} from './format.js';
import {
  renderMemoryMap, updateUnit, keyForBlock, dataForUnit,
} from './memorymap.js';
import {
  buildDOM,
  renderStatus,
  renderOpResult,
  renderAutoReadState,
  renderWriteError,
  clearWriteError,
  renderPageWriteError,
  clearPageWriteError,
  renderConsoleError,
  renderCloneImage,
  renderCloneTarget,
  renderCloneProgress,
  renderCloneSummary,
  renderCloneError,
  renderKeyDictStatus,
  renderAts,
  renderApduResponse,
  appendLog,
  clearLog,
  getConnectBtn,
  getDisconnectBtn,
  getBlockInput,
  getKeyInput,
  getDataInput,
  getPageInput,
  getPageDataInput,
  getRescanInput,
  getRawInput,
  getAutoReadToggle,
  getCloneImportInput,
  getKeyDictToggle,
  getApduInput,
  getMemmapContainer,
  getHexAsciiToggle,
} from './ui.js';

declare global {
  interface Window {
    __mockEmitCardPresent?: (uid?: string) => void;
    __mockSetCard?: (kind: MockCardKind) => void;
  }
}

buildDOM();

const transport = createTransport();
const controller = new RfidController(transport);
const tabs = createTabs();

// Tabs requiring a connection.
const CONN_TABS: TabId[] = ['read', 'edit', 'clone', 'identify'];

// ── View mode (hex/ascii) ─────────────────────────────────────────────────────

let viewMode: ViewMode = getViewMode();
let lastImage: import('./types.js').CardImage | null = null;

function applyHexAsciiToggleUi(): void {
  const t = getHexAsciiToggle();
  t.setAttribute('aria-pressed', viewMode === 'ascii' ? 'true' : 'false');
}

// ── Edit controller (SINGLE write path) ───────────────────────────────────────

const editController = new EditController({
  controller,
  onLog: (line) => appendLog(line, 'tx'),
  onResult: (result) => renderOpResult(result),
  renderWriteError,
  clearWriteError,
  renderPageWriteError,
  clearPageWriteError,
  onWritten: (_kind, addr, hex) => updateUnit(addr, hex),
});

// ── Auto-read ─────────────────────────────────────────────────────────────────

const autoReader = new AutoReader({
  controller,
  isEnabled: () => getAutoReadToggle().checked,
  getBlock: () => parseInt(getBlockInput().value, 10),
  getKey: () => getKeyInput().value,
  getPage: () => parseInt(getPageInput().value, 10),
  onResult: (result) => renderOpResult(result),
  onLog: (line) => appendLog(line, 'tx'),
});

const autoReadToggle = getAutoReadToggle();
autoReadToggle.checked = false; // default OFF
renderAutoReadState(false);
autoReadToggle.addEventListener('change', () => {
  renderAutoReadState(autoReadToggle.checked);
});

// ── Clone workflow ─────────────────────────────────────────────────────────────

const cloneController = new CloneController({
  controller,
  onProgress: (done, total) => renderCloneProgress(done, total),
  onLog: (line) => appendLog(line, 'tx'),
});

getKeyDictToggle().addEventListener('change', () => {
  renderKeyDictStatus(getKeyDictToggle().checked);
});

document.getElementById('cloneRead')?.addEventListener('click', async () => {
  const result = await cloneController.readSource();
  if (result.ok && result.image) {
    renderCloneImage(result.image);
  } else {
    renderCloneError(`Read failed: ${result.error ?? 'unknown'}`);
  }
});

document.getElementById('cloneDetect')?.addEventListener('click', async () => {
  const { scan, blocked } = await cloneController.detectTarget();
  const target = cloneController.target;
  const magic = cloneController.targetMagic;
  if (target) {
    const familyMatch = !blocked;
    renderCloneTarget(target, magic, familyMatch);
  } else {
    renderCloneError(`Detect failed: ${scan.error ?? 'no card'}`);
  }
});

document.getElementById('cloneWrite')?.addEventListener('click', async () => {
  if (!cloneController.image) { renderCloneError('Read a source image first.'); return; }
  if (!cloneController.target) { renderCloneError('Detect a target first.'); return; }
  const summary = await cloneController.writeClone();
  if (summary === null) return; // cancelled → nothing written
  renderCloneSummary(summary);
});

document.getElementById('cloneExport')?.addEventListener('click', () => {
  const json = cloneController.exportJson();
  getCloneImportInput().value = json;
  appendLog('Exported image JSON to import box.');
});

document.getElementById('cloneImport')?.addEventListener('click', () => {
  try {
    const image = cloneController.importJson(getCloneImportInput().value);
    renderCloneImage(image);
    appendLog('Imported image JSON.');
  } catch (err) {
    renderCloneError(`Import failed: ${String(err)}`);
  }
});

// ── ISO4 identify (ATS / APDU) ────────────────────────────────────────────────

document.getElementById('atsRead')?.addEventListener('click', async () => {
  appendLog('ATS', 'tx');
  const result = await controller.ats();
  if (result.ok && result.ats) renderAts(result.ats);
  renderOpResult(result);
});

document.getElementById('apduSend')?.addEventListener('click', async () => {
  const hex = cleanHex(getApduInput().value);
  appendLog(`APDU ${hex}`, 'tx');
  const result = await controller.apdu(hex);
  if (result.ok && result.apdu) renderApduResponse(result.apdu);
  renderOpResult(result);
});

// ── Full memory map (Read tab) ────────────────────────────────────────────────

document.getElementById('readFullMap')?.addEventListener('click', async () => {
  appendLog('CLONE_READ (full map)', 'tx');
  const result = await controller.cloneRead();
  if (result.ok && result.image) {
    lastImage = result.image;
    renderMemoryMap(getMemmapContainer(), result.image, viewMode);
  } else {
    renderOpResult(result);
  }
});

getHexAsciiToggle().addEventListener('click', () => {
  viewMode = viewMode === 'hex' ? 'ascii' : 'hex';
  setViewMode(viewMode);
  applyHexAsciiToggleUi();
  // Flip the table class (display-only); re-render to be safe for new maps.
  const table = getMemmapContainer().querySelector<HTMLElement>('[data-testid="memmap"]');
  if (table) table.classList.toggle('memmap--ascii', viewMode === 'ascii');
  else if (lastImage) renderMemoryMap(getMemmapContainer(), lastImage, viewMode);
});
applyHexAsciiToggleUi();

// ── From-map edit requests ─────────────────────────────────────────────────────

getMemmapContainer().addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const editBtn = target.closest<HTMLButtonElement>('button[data-block]');
  if (!editBtn || editBtn.disabled) return;
  const testid = editBtn.getAttribute('data-testid') ?? '';
  const addr = parseInt(editBtn.getAttribute('data-block') ?? '', 10);
  if (Number.isNaN(addr)) return;
  const isPage = testid.startsWith('memmap-edit-page-');
  const hex = dataForUnit(addr, isPage) ?? '';
  const detail: EditRequest = { kind: isPage ? 'page' : 'block', addr, hex };
  if (!isPage) {
    const k = keyForBlock(addr);
    if (k) detail.key = k;
  }
  document.dispatchEvent(new CustomEvent<EditRequest>('rfid:edit-request', { detail }));
});

interface EditRequest { kind: 'block' | 'page'; addr: number; hex: string; key?: string }

document.addEventListener('rfid:edit-request', (ev) => {
  const detail = (ev as CustomEvent<EditRequest>).detail;
  tabs.show('edit');
  if (detail.kind === 'block') {
    getBlockInput().value = String(detail.addr);
    if (detail.key) getKeyInput().value = detail.key;
    if (detail.hex) getDataInput().value = detail.hex;
    getDataInput().focus();
  } else {
    getPageInput().value = String(detail.addr);
    if (detail.hex) getPageDataInput().value = detail.hex;
    getPageDataInput().focus();
  }
});

// ── Transport events ──────────────────────────────────────────────────────────

transport.onStatus(connected => {
  renderStatus(connected);
  appendLog(connected ? 'Connected' : 'Disconnected');
  // Enable/disable connection-only tabs.
  for (const t of CONN_TABS) tabs.setEnabled(t, connected);
  if (connected) {
    void applyRescan();
  } else {
    autoReader.reset();
    cloneController.reset();
    // If the active tab is now disabled, fall back to Console.
    if (CONN_TABS.includes(tabs.active())) tabs.show('console');
  }
});

transport.onLine(line => {
  appendLog(line, 'rx');
});

controller.onEvent(line => {
  autoReader.handleLine(line);
});

// ── Mock-only test hooks ──────────────────────────────────────────────────────

if (transport instanceof MockSerialTransport) {
  const mock = transport;
  window.__mockEmitCardPresent = (uid?: string) => mock.emitCardPresent(uid);
  window.__mockSetCard = (kind: MockCardKind) => mock.setCard(kind);
}

// ── Re-scan interval control ──────────────────────────────────────────────────

async function applyRescan(): Promise<void> {
  const raw = getRescanInput().value.trim();
  const ms = Math.max(0, parseInt(raw || '0', 10) || 0);
  appendLog(`RESCAN ${ms}`, 'tx');
  const result = await controller.rescan(ms);
  if (result.ok && result.rescan !== undefined) {
    appendLog(`Re-scan interval set to ${result.rescan} ms`);
  }
  renderOpResult(result);
}

document.getElementById('rescanApply')?.addEventListener('click', () => {
  applyRescan().catch(err => appendLog(String(err)));
});

// ── Connection buttons ────────────────────────────────────────────────────────

getConnectBtn().addEventListener('click', () => {
  transport.connect().catch(err => appendLog(`Connect failed: ${String(err)}`));
});

getDisconnectBtn().addEventListener('click', () => {
  transport.disconnect().catch(err => appendLog(`Disconnect failed: ${String(err)}`));
});

// ── Quick command buttons ────────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const cmd = btn.dataset['cmd'] ?? '';
    appendLog(cmd, 'tx');
    let result;
    switch (cmd) {
      case 'PING':    result = await controller.ping();    break;
      case 'VERSION': result = await controller.version(); break;
      case 'HELP':    result = await controller.help();    break;
      case 'SCAN':    result = await controller.scan();    break;
      default: return;
    }
    renderOpResult(result);
  });
});

// ── Single read / dump (Edit tab) ─────────────────────────────────────────────

document.getElementById('readBlock')?.addEventListener('click', async () => {
  const block = parseInt(getBlockInput().value, 10);
  const key = cleanHex(getKeyInput().value);
  appendLog(`READ_BLOCK ${block} ${key}`.trim(), 'tx');
  const result = await controller.readBlock(block, key || undefined);
  renderOpResult(result);
});

document.getElementById('dumpSector')?.addEventListener('click', async () => {
  const block = parseInt(getBlockInput().value, 10);
  const key = cleanHex(getKeyInput().value);
  appendLog(`DUMP (sector of block ${block})`, 'tx');
  const result = await controller.dump(block, key || undefined);
  renderOpResult(result);
});

document.getElementById('readPage')?.addEventListener('click', async () => {
  const page = parseInt(getPageInput().value, 10);
  appendLog(`READ_PAGE ${page}`, 'tx');
  const result = await controller.readPage(page);
  renderOpResult(result);
});

// "Read into editor" prefills the editor textarea with the current value.
document.getElementById('editRead')?.addEventListener('click', async () => {
  const block = parseInt(getBlockInput().value, 10);
  const key = cleanHex(getKeyInput().value);
  appendLog(`READ_BLOCK ${block} ${key}`.trim(), 'tx');
  const result = await controller.readBlock(block, key || undefined);
  renderOpResult(result);
  if (result.ok && result.block) getDataInput().value = cleanHex(result.block.data);
});

document.getElementById('editReadPage')?.addEventListener('click', async () => {
  const page = parseInt(getPageInput().value, 10);
  appendLog(`READ_PAGE ${page}`, 'tx');
  const result = await controller.readPage(page);
  renderOpResult(result);
  if (result.ok && result.page) getPageDataInput().value = cleanHex(result.page.data);
});

// ── Write (Edit tab) — SINGLE write path via EditController ────────────────────

document.getElementById('writeBlock')?.addEventListener('click', async () => {
  const block = parseInt(getBlockInput().value, 10);
  const hex = cleanHex(getDataInput().value);
  const key = cleanHex(getKeyInput().value);
  await editController.writeBlock(block, hex, key);
});

document.getElementById('writePage')?.addEventListener('click', async () => {
  const page = parseInt(getPageInput().value, 10);
  const hex = cleanHex(getPageDataInput().value);
  await editController.writePage(page, hex);
});

// ── Raw command (Console) ─────────────────────────────────────────────────────

async function sendRaw(raw: string): Promise<void> {
  const trimmed = raw.trim();
  if (!trimmed) return;

  const upper = trimmed.toUpperCase();

  // Refuse bulk-destructive raw ops so they cannot bypass confirmClone.
  // (Single WRITE_BLOCK / WRITE_PAGE below still route through confirmWrite.)
  if (
    upper.startsWith('WRITE_BLOCK_RAW') ||
    upper.startsWith('WRITE_TRAILER') ||
    upper.startsWith('WRITE_PAGE_RAW') ||
    upper.startsWith('CLONE_UID')
  ) {
    const msg = 'Bulk/raw write commands are disabled here — use the Clone panel.';
    renderWriteError(msg);
    renderConsoleError(msg);
    appendLog(`Refused raw command "${trimmed.split(/\s+/)[0]}" — use the Clone panel.`);
    return;
  }

  if (upper.startsWith('WRITE_BLOCK')) {
    const parts = trimmed.split(/\s+/);
    const block = parseInt(parts[1] ?? '0', 10);
    const hex = cleanHex(parts[2] ?? '');
    const key = cleanHex(parts[3] ?? '');
    await editController.writeBlock(block, hex, key);
    return;
  }
  if (upper.startsWith('WRITE_PAGE')) {
    const parts = trimmed.split(/\s+/);
    const page = parseInt(parts[1] ?? '0', 10);
    const hex = cleanHex(parts[2] ?? '');
    await editController.writePage(page, hex);
    return;
  }

  // Route known read/scan commands through the controller so their result —
  // including ERR (WRONG_CARD_TYPE / UNSUPPORTED_CARD / REFUSE_PAGE) — is
  // surfaced cleanly in the card panel + badge, not just logged.
  const parts = trimmed.split(/\s+/);
  appendLog(trimmed, 'tx');
  if (upper.startsWith('READ_BLOCK')) {
    const block = parseInt(parts[1] ?? '0', 10);
    const key = cleanHex(parts[2] ?? '');
    renderOpResult(await controller.readBlock(block, key || undefined));
    return;
  }
  if (upper.startsWith('READ_PAGE')) {
    const pageNum = parseInt(parts[1] ?? '0', 10);
    renderOpResult(await controller.readPage(pageNum));
    return;
  }
  if (upper === 'SCAN' || upper === 'UID' || upper === 'READ_UID') {
    renderOpResult(await controller.scan());
    return;
  }

  await transport.send(trimmed);
}

document.getElementById('sendRaw')?.addEventListener('click', () => {
  sendRaw(getRawInput().value).catch(err => appendLog(String(err)));
});

getRawInput().addEventListener('keydown', (ev: KeyboardEvent) => {
  if (ev.key === 'Enter') {
    sendRaw(getRawInput().value).catch(err => appendLog(String(err)));
  }
});

// ── Clear log ────────────────────────────────────────────────────────────────

document.getElementById('clearLog')?.addEventListener('click', clearLog);
