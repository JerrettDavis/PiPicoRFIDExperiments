import { trailerForBlock } from './protocol.js';
import { hexGrouped, hexToAscii, capacityFor, coverageOf, type ViewMode } from './format.js';
import type { CardImage } from './types.js';

let currentImage: CardImage | null = null;
let currentMode: ViewMode = 'hex';

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function classicRole(block: number): { role: 'manufacturer' | 'trailer' | 'data'; label: string } {
  if (block === 0) return { role: 'manufacturer', label: 'MFR' };
  if (trailerForBlock(block) === block) return { role: 'trailer', label: 'TRAIL' };
  return { role: 'data', label: 'DATA' };
}

function ulRole(page: number): { role: string; label: string } {
  if (page <= 1) return { role: 'uid', label: 'UID' };
  if (page === 2) return { role: 'lock', label: 'LOCK' };
  if (page === 3) return { role: 'cc', label: 'CC' };
  // CONFIG pages live at the tail of NTAG; treat the top few as CONFIG, rest USER.
  return { role: 'user', label: 'USER' };
}

function hexCode(testid: string, hex: string): HTMLElement {
  const code = document.createElement('code');
  code.className = 'hex';
  code.setAttribute('data-testid', testid);
  code.textContent = hexGrouped(hex);
  return code;
}

function asciiCode(testid: string, hex: string): HTMLElement {
  const code = document.createElement('code');
  code.className = 'ascii';
  code.setAttribute('data-testid', testid);
  code.textContent = hexToAscii(hex);
  return code;
}

function editBtn(testid: string, addr: number, disabled: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.setAttribute('data-testid', testid);
  b.setAttribute('data-block', String(addr));
  b.textContent = 'Edit';
  b.disabled = disabled;
  return b;
}

function buildClassic(image: CardImage): DocumentFragment {
  const frag = document.createDocumentFragment();
  const table = document.createElement('table');
  table.setAttribute('data-testid', 'memmap');
  table.className = 'memmap' + (currentMode === 'ascii' ? ' memmap--ascii' : '');

  const tbody = document.createElement('tbody');

  for (const sec of image.sectors ?? []) {
    const failed = sec.status === 'FAILED';

    // Sector header row.
    const headRow = document.createElement('tr');
    headRow.setAttribute('data-testid', `memmap-sector-head-${sec.sector}`);
    headRow.className = 'memmap-sector-head' + (failed ? ' failed' : '');
    const headCell = document.createElement('td');
    headCell.colSpan = 5;
    headCell.textContent =
      `SECTOR ${sec.sector}  KEY=${sec.key}  KEYTYPE=${sec.keyType}  STATUS=${sec.status}`;
    headRow.appendChild(headCell);
    tbody.appendChild(headRow);

    for (const blk of sec.blocks) {
      const { role, label } = classicRole(blk.block);
      const row = document.createElement('tr');
      row.setAttribute('data-testid', `memmap-block-${blk.block}`);
      row.setAttribute('data-role', role);
      if (failed || blk.err) row.classList.add('failed');

      row.appendChild(cell(String(blk.block)));
      row.appendChild(cell(label));

      if (failed || blk.err || blk.data === undefined) {
        const errCell = document.createElement('td');
        errCell.colSpan = 2;
        errCell.className = 'memmap-err';
        errCell.textContent = `ERR ${blk.err ?? 'AUTH_FAILED'}`;
        row.appendChild(errCell);
      } else {
        const hexTd = document.createElement('td');
        hexTd.appendChild(hexCode(`memmap-hex-${blk.block}`, blk.data));
        row.appendChild(hexTd);
        const asciiTd = document.createElement('td');
        asciiTd.appendChild(asciiCode(`memmap-ascii-${blk.block}`, blk.data));
        row.appendChild(asciiTd);
      }

      // Edit disabled for block 0, trailers, and FAILED/err rows.
      const disabled = role === 'manufacturer' || role === 'trailer' || failed || !!blk.err || blk.data === undefined;
      const editTd = document.createElement('td');
      editTd.appendChild(editBtn(`memmap-edit-${blk.block}`, blk.block, disabled));
      row.appendChild(editTd);

      tbody.appendChild(row);
    }
  }

  table.appendChild(tbody);
  frag.appendChild(table);
  frag.appendChild(buildSummary(image));
  return frag;
}

function buildUl(image: CardImage): DocumentFragment {
  const frag = document.createDocumentFragment();
  const table = document.createElement('table');
  table.setAttribute('data-testid', 'memmap');
  table.className = 'memmap' + (currentMode === 'ascii' ? ' memmap--ascii' : '');

  const tbody = document.createElement('tbody');

  for (const pg of image.pages ?? []) {
    const { role, label } = ulRole(pg.page);
    const row = document.createElement('tr');
    row.setAttribute('data-testid', `memmap-page-${pg.page}`);
    row.setAttribute('data-role', role);
    if (pg.err) row.classList.add('failed');

    row.appendChild(cell(String(pg.page)));
    row.appendChild(cell(label));

    if (pg.err || pg.data === undefined) {
      const errCell = document.createElement('td');
      errCell.colSpan = 2;
      errCell.className = 'memmap-err';
      errCell.textContent = `ERR ${pg.err ?? 'READ_FAILED'}`;
      row.appendChild(errCell);
    } else {
      const hexTd = document.createElement('td');
      hexTd.appendChild(hexCode(`memmap-page-hex-${pg.page}`, pg.data));
      row.appendChild(hexTd);
      const asciiTd = document.createElement('td');
      asciiTd.appendChild(asciiCode(`memmap-page-ascii-${pg.page}`, pg.data));
      row.appendChild(asciiTd);
    }

    // Pages 0-3 (UID/lock/CC/OTP) are not editable.
    const disabled = pg.page <= 3 || !!pg.err || pg.data === undefined;
    const editTd = document.createElement('td');
    editTd.appendChild(editBtn(`memmap-edit-page-${pg.page}`, pg.page, disabled));
    row.appendChild(editTd);

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  frag.appendChild(table);
  frag.appendChild(buildSummary(image));
  return frag;
}

function buildSummary(image: CardImage): HTMLElement {
  const cap = capacityFor(image.type);
  const cov = coverageOf(image, cap);
  const div = document.createElement('div');
  div.setAttribute('data-testid', 'memmap-summary');
  div.className = 'memmap-summary';

  if (image.family === 'ULTRALIGHT' || image.pages) {
    div.textContent =
      `Capacity: ${cov.unitsTotal} pages / ${cap.totalBytes}B · ` +
      `Read ${cov.unitsRead}/${cov.unitsTotal} · Failed ${cov.unitsFailed}`;
  } else {
    const failedSectors = (image.sectors ?? [])
      .filter(s => s.status === 'FAILED')
      .map(s => s.sector);
    const failedStr = failedSectors.length ? ` (sectors ${failedSectors.join(', ')})` : '';
    div.textContent =
      `Capacity: ${cap.sectors} sectors / ${cap.blocks} blocks / ${cap.totalBytes}B · ` +
      `Read ${cov.unitsRead}/${cov.unitsTotal} · Failed ${cov.unitsFailed}${failedStr}`;
  }
  return div;
}

/** Render the full memory map for an image into `container`. */
export function renderMemoryMap(container: HTMLElement, image: CardImage, mode: ViewMode): void {
  currentImage = image;
  currentMode = mode;
  const frag = (image.family === 'ULTRALIGHT' || image.pages)
    ? buildUl(image)
    : buildClassic(image);
  container.replaceChildren(frag);
}

/** Re-render just one row's hex/ascii after a successful write. */
export function updateUnit(addr: number, hex: string): void {
  if (!currentImage) return;
  const isUl = currentImage.family === 'ULTRALIGHT' || !!currentImage.pages;
  if (isUl) {
    const pg = currentImage.pages?.find(p => p.page === addr);
    if (pg) pg.data = hex;
    const hexEl = document.querySelector<HTMLElement>(`[data-testid="memmap-page-hex-${addr}"]`);
    const asciiEl = document.querySelector<HTMLElement>(`[data-testid="memmap-page-ascii-${addr}"]`);
    if (hexEl) hexEl.textContent = hexGrouped(hex);
    if (asciiEl) asciiEl.textContent = hexToAscii(hex);
  } else {
    for (const sec of currentImage.sectors ?? []) {
      const blk = sec.blocks.find(b => b.block === addr);
      if (blk) { blk.data = hex; break; }
    }
    const hexEl = document.querySelector<HTMLElement>(`[data-testid="memmap-hex-${addr}"]`);
    const asciiEl = document.querySelector<HTMLElement>(`[data-testid="memmap-ascii-${addr}"]`);
    if (hexEl) hexEl.textContent = hexGrouped(hex);
    if (asciiEl) asciiEl.textContent = hexToAscii(hex);
  }
}

/** Get the recovered key for a block's sector, or null when unknown. */
export function keyForBlock(addr: number): string | null {
  if (!currentImage || !currentImage.sectors) return null;
  for (const sec of currentImage.sectors) {
    if (sec.blocks.some(b => b.block === addr)) {
      return sec.key && sec.key !== '------------' ? sec.key : null;
    }
  }
  return null;
}

/** Read the current hex for a block/page (for edit prefill). */
export function dataForUnit(addr: number, isPage: boolean): string | null {
  if (!currentImage) return null;
  if (isPage) {
    return currentImage.pages?.find(p => p.page === addr)?.data ?? null;
  }
  for (const sec of currentImage.sectors ?? []) {
    const blk = sec.blocks.find(b => b.block === addr);
    if (blk) return blk.data ?? null;
  }
  return null;
}
