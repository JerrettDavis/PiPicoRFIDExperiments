import { test, expect, type Page } from '@playwright/test';

const URL = 'http://localhost:4188/PiPicoRFIDExperiments/?mock=1';
const SEEDED_PAGE4 = '48656C6C';
const NEW_PAGE_DATA = 'AABBCCDD'; // 4 bytes / 8 hex

async function connect(page: Page): Promise<void> {
  await page.goto(URL);
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
}

// Select a mock card and SCAN so the UI switches to that family's controls.
async function selectAndScan(page: Page, kind: 'classic' | 'ultralight' | 'iso4'): Promise<void> {
  await page.evaluate((k) => window.__mockSetCard!(k as never), kind);
  await page.getByTestId('btn-scan').click();
}

// ── Ultralight ────────────────────────────────────────────────────────────────

test('Ultralight: scan switches to page controls and shows TYPE/SIZE', async ({ page }) => {
  await connect(page);
  await selectAndScan(page, 'ultralight');

  await expect(page.getByTestId('card-panel')).toContainText('MIFARE_UL', { timeout: 3000 });
  await expect(page.getByTestId('card-panel')).toContainText('SIZE: 7', { timeout: 3000 });
  await expect(page.getByTestId('ultralight-controls')).toBeVisible();
  await expect(page.getByTestId('classic-controls')).toBeHidden();
});

test('Ultralight: Read Page returns seeded page data', async ({ page }) => {
  await connect(page);
  await selectAndScan(page, 'ultralight');

  await page.getByTestId('input-page').fill('4');
  await page.getByTestId('btn-read-page').click();
  await expect(page.getByTestId('card-panel')).toContainText(SEEDED_PAGE4, { timeout: 3000 });
  await expect(page.getByTestId('badge-success')).toBeVisible({ timeout: 3000 });
});

test('Ultralight: Write Page goes through two-step confirm and persists', async ({ page }) => {
  await connect(page);
  await selectAndScan(page, 'ultralight');

  await page.getByTestId('input-page').fill('5');
  await page.getByTestId('input-page-data').fill(NEW_PAGE_DATA);
  await page.getByTestId('btn-write-page').click();

  // Two-step confirm modal (same component as block write).
  await expect(page.getByTestId('write-confirm-modal')).toBeVisible({ timeout: 2000 });
  // No write yet.
  await expect(page.getByTestId('log')).not.toContainText('WROTE_PAGE');

  // Step 1
  await page.getByTestId('confirm-ack').check();
  await page.getByTestId('confirm-step1').click();
  // Step 2: type the page number
  await expect(page.getByTestId('write-confirm-step2')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('confirm-type').fill('5');
  await page.getByTestId('confirm-step2').click();

  await expect(page.getByTestId('log')).toContainText('OK WROTE_PAGE PAGE=5', { timeout: 3000 });

  // Read page 5 back -> new value persisted.
  await page.getByTestId('input-page').fill('5');
  await page.getByTestId('btn-read-page').click();
  await expect(page.getByTestId('card-panel')).toContainText(NEW_PAGE_DATA, { timeout: 3000 });
});

test('Ultralight: writing a protected page (0-3) surfaces ERR REFUSE_PAGE without sending', async ({ page }) => {
  await connect(page);
  await selectAndScan(page, 'ultralight');

  // Page 2 is protected -> inline validation, modal must NOT open.
  await page.getByTestId('input-page').fill('2');
  await page.getByTestId('input-page-data').fill(NEW_PAGE_DATA);
  await page.getByTestId('btn-write-page').click();

  await expect(page.getByTestId('page-write-error')).toContainText('protected', { timeout: 2000 });
  await expect(page.getByTestId('write-confirm-modal')).not.toBeVisible();
  await expect(page.getByTestId('log')).not.toContainText('WROTE_PAGE');
});

// ── WRONG_CARD_TYPE ─────────────────────────────────────────────────────────

test('WRONG_CARD_TYPE: READ_BLOCK on an Ultralight card surfaces the USE hint', async ({ page }) => {
  await connect(page);
  await selectAndScan(page, 'ultralight');

  // Send a raw READ_BLOCK while a UL card is present.
  await page.getByTestId('input-raw').fill('READ_BLOCK 4');
  await page.getByTestId('btn-send-raw').click();

  await expect(page.getByTestId('log')).toContainText('ERR WRONG_CARD_TYPE USE=READ_PAGE', { timeout: 3000 });
  await expect(page.getByTestId('card-panel')).toContainText('WRONG_CARD_TYPE', { timeout: 3000 });
});

// ── ISO_14443_4 ─────────────────────────────────────────────────────────────

test('ISO4: panel shows UID-only / unsupported state', async ({ page }) => {
  await connect(page);
  await selectAndScan(page, 'iso4');

  await expect(page.getByTestId('card-panel')).toContainText('ISO_14443_4', { timeout: 3000 });
  await expect(page.getByTestId('card-panel')).toContainText('04666BA27A1890', { timeout: 3000 });
  await expect(page.getByTestId('unsupported-notice')).toBeVisible();
  await expect(page.getByTestId('classic-controls')).toBeHidden();
  await expect(page.getByTestId('ultralight-controls')).toBeHidden();
});

test('ISO4: a block read surfaces ERR UNSUPPORTED_CARD (no crash/hang)', async ({ page }) => {
  await connect(page);
  await selectAndScan(page, 'iso4');

  await page.getByTestId('input-raw').fill('READ_BLOCK 4');
  await page.getByTestId('btn-send-raw').click();

  await expect(page.getByTestId('log')).toContainText('ERR UNSUPPORTED_CARD TYPE=ISO_14443_4', { timeout: 3000 });
  await expect(page.getByTestId('card-panel')).toContainText('UNSUPPORTED_CARD', { timeout: 3000 });
});

// ── RESCAN ──────────────────────────────────────────────────────────────────

test('RESCAN: applying an interval sends RESCAN <ms> and shows OK', async ({ page }) => {
  await connect(page);

  await page.getByTestId('input-rescan').fill('250');
  await page.getByTestId('btn-rescan').click();

  await expect(page.getByTestId('log')).toContainText('> RESCAN 250', { timeout: 3000 });
  await expect(page.getByTestId('log')).toContainText('OK RESCAN 250', { timeout: 3000 });
});

test('RESCAN-driven repeat: auto-read fires again when the mock emits a second EVENT', async ({ page }) => {
  await page.goto(URL);
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  // Boot CARD_PRESENT -> one auto-read.
  const log = page.getByTestId('log');
  await expect.poll(async () => ((await log.textContent()) ?? '').match(/> READ_BLOCK/g)?.length ?? 0).toBe(1);

  // A RESCAN-driven repeat is simulated by the mock re-emitting CARD_PRESENT.
  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));
  await expect.poll(
    async () => ((await log.textContent()) ?? '').match(/> READ_BLOCK/g)?.length ?? 0,
    { timeout: 3000 },
  ).toBe(2);
});
