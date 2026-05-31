import './style.css';
import { createTransport } from './serial/transport.js';
import { RfidController } from './controller.js';
import { cleanHex } from './protocol.js';
import { confirmWrite } from './confirm.js';
import {
  buildDOM,
  renderStatus,
  renderOpResult,
  renderWriteError,
  clearWriteError,
  appendLog,
  clearLog,
  getConnectBtn,
  getDisconnectBtn,
  getBlockInput,
  getKeyInput,
  getDataInput,
  getRawInput,
} from './ui.js';

buildDOM();

const transport = createTransport();
const controller = new RfidController(transport);

// ── Transport events ──────────────────────────────────────────────────────────

transport.onStatus(connected => {
  renderStatus(connected);
  appendLog(connected ? 'Connected' : 'Disconnected');
});

transport.onLine(line => {
  appendLog(line, 'rx');
});

controller.onEvent(line => {
  // Events are already logged via onLine; no extra action needed here
  void line;
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
  if (block % 4 === 3) {
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

  appendLog(trimmed, 'tx');
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
