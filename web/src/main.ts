import './style.css';
import { createTransport } from './serial/transport.js';
import { MockSerialTransport, type MockCardKind } from './serial/mockPico.js';
import { RfidController } from './controller.js';
import { cleanHex, trailerForBlock } from './protocol.js';
import { confirmWrite } from './confirm.js';
import { AutoReader } from './autoread.js';
import {
  buildDOM,
  renderStatus,
  renderOpResult,
  renderAutoReadState,
  renderWriteError,
  clearWriteError,
  renderPageWriteError,
  clearPageWriteError,
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

// ── Transport events ──────────────────────────────────────────────────────────

transport.onStatus(connected => {
  renderStatus(connected);
  appendLog(connected ? 'Connected' : 'Disconnected');
  if (connected) {
    // Push the current re-scan interval to the firmware on connect.
    void applyRescan();
  } else {
    autoReader.reset();
  }
});

transport.onLine(line => {
  appendLog(line, 'rx');
});

controller.onEvent(line => {
  // Unsolicited events (e.g. EVENT CARD_PRESENT) drive auto-read.
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

// ── Read / Dump ───────────────────────────────────────────────────────────────

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

// ── Write (two-step confirm) ──────────────────────────────────────────────────

async function doWrite(block: number, hex: string, key: string): Promise<void> {
  // Pre-validate before opening modal
  if (block === 0) {
    renderWriteError('Block 0 is protected (UID/manufacturer data).');
    return;
  }
  if (trailerForBlock(block) === block) {
    renderWriteError(`Block ${block} is a sector trailer — writes refused.`);
    return;
  }
  if (hex.length !== 32) {
    renderWriteError(`Data must be exactly 32 hex chars (got ${hex.length}).`);
    return;
  }
  clearWriteError();

  const confirmed = await confirmWrite({ block, data: hex, key });
  if (!confirmed) return;

  appendLog(`WRITE_BLOCK ${block} ${hex} ${key}`.trim(), 'tx');
  const result = await controller.writeBlock(block, hex, key || undefined);
  renderOpResult(result);
}

document.getElementById('writeBlock')?.addEventListener('click', async () => {
  const block = parseInt(getBlockInput().value, 10);
  const hex = cleanHex(getDataInput().value);
  const key = cleanHex(getKeyInput().value);
  await doWrite(block, hex, key);
});

// ── Ultralight page read / write ──────────────────────────────────────────────

document.getElementById('readPage')?.addEventListener('click', async () => {
  const page = parseInt(getPageInput().value, 10);
  appendLog(`READ_PAGE ${page}`, 'tx');
  const result = await controller.readPage(page);
  renderOpResult(result);
});

// WRITE_PAGE goes through the SAME two-step confirmation as WRITE_BLOCK.
async function doWritePage(page: number, hex: string): Promise<void> {
  if (page <= 3) {
    renderPageWriteError(`Page ${page} is protected (pages 0–3) — writes refused.`);
    return;
  }
  if (hex.length !== 8) {
    renderPageWriteError(`Data must be exactly 8 hex chars / 4 bytes (got ${hex.length}).`);
    return;
  }
  clearPageWriteError();

  const confirmed = await confirmWrite({ block: page, data: hex, key: '', unit: 'page' });
  if (!confirmed) return;

  appendLog(`WRITE_PAGE ${page} ${hex}`, 'tx');
  const result = await controller.writePage(page, hex);
  renderOpResult(result);
}

document.getElementById('writePage')?.addEventListener('click', async () => {
  const page = parseInt(getPageInput().value, 10);
  const hex = cleanHex(getPageDataInput().value);
  await doWritePage(page, hex);
});

// ── Raw command (intercepts WRITE_BLOCK) ─────────────────────────────────────

async function sendRaw(raw: string): Promise<void> {
  const trimmed = raw.trim();
  if (!trimmed) return;

  const upper = trimmed.toUpperCase();
  if (upper.startsWith('WRITE_BLOCK')) {
    const parts = trimmed.split(/\s+/);
    const block = parseInt(parts[1] ?? '0', 10);
    const hex = cleanHex(parts[2] ?? '');
    const key = cleanHex(parts[3] ?? '');
    await doWrite(block, hex, key);
    return;
  }
  if (upper.startsWith('WRITE_PAGE')) {
    const parts = trimmed.split(/\s+/);
    const page = parseInt(parts[1] ?? '0', 10);
    const hex = cleanHex(parts[2] ?? '');
    await doWritePage(page, hex);
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
