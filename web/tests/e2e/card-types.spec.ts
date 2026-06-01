import { test, expect, type Page } from '@playwright/test';
import { gotoConnected, openTab, setCard } from './_helpers.js';

const SEEDED_PAGE4 = '48656C6C';
const NEW_PAGE_DATA = 'AABBCCDD'; // 4 bytes / 8 hex

// Select a mock card and SCAN (on the Read tab) so the UI adapts to that family.
async function selectAndScan(page: Page, kind: 'classic' | 'ultralight' | 'iso4'): Promise<void> {
  await setCard(page, kind);
  await openTab(page, 'read');
  await page.getByTestId('btn-scan').click();
}

// ── Ultralight ────────────────────────────────────────────────────────────────

test('Ultralight: scan switches to page controls and shows TYPE/SIZE', async ({ page }) => {
  await gotoConnected(page);
  await selectAndScan(page, 'ultralight');

  await expect(page.getByTestId('card-panel')).toContainText('MIFARE_UL', { timeout: 3000 });
  await expect(page.getByTestId('card-panel')).toContainText('SIZE: 7', { timeout: 3000 });
  // The editor sub-groups live on the Edit tab; UL group is shown, Classic hidden.
  await openTab(page, 'edit');
  await expect(page.getByTestId('ultralight-controls')).toBeVisible();
  await expect(page.getByTestId('classic-controls')).toBeHidden();
});

test('Ultralight: Read Page returns seeded page data', async ({ page }) => {
  await gotoConnected(page);
  await selectAndScan(page, 'ultralight');
  await openTab(page, 'edit');

  await page.getByTestId('input-page').fill('4');
  await page.getByTestId('btn-read-page').click();
  await expect(page.getByTestId('card-panel')).toContainText(SEEDED_PAGE4, { timeout: 3000 });
  await expect(page.getByTestId('badge-success')).toBeVisible({ timeout: 3000 });
});

test('Ultralight: Write Page goes through two-step confirm and persists', async ({ page }) => {
  await gotoConnected(page);
  await selectAndScan(page, 'ultralight');
  await openTab(page, 'edit');

  await page.getByTestId('input-page').fill('5');
  await page.getByTestId('input-page-data').fill(NEW_PAGE_DATA);
  await page.getByTestId('btn-write-page').click();

  await expect(page.getByTestId('write-confirm-modal')).toBeVisible({ timeout: 2000 });
  await expect(page.getByTestId('log')).not.toContainText('WROTE_PAGE');

  await page.getByTestId('confirm-ack').check();
  await page.getByTestId('confirm-step1').click();
  await expect(page.getByTestId('write-confirm-step2')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('confirm-type').fill('5');
  await page.getByTestId('confirm-step2').click();

  await expect(page.getByTestId('log')).toContainText('OK WROTE_PAGE PAGE=5', { timeout: 3000 });

  await page.getByTestId('input-page').fill('5');
  await page.getByTestId('btn-read-page').click();
  await expect(page.getByTestId('card-panel')).toContainText(NEW_PAGE_DATA, { timeout: 3000 });
});

test('Ultralight: writing a protected page (0-3) surfaces ERR REFUSE_PAGE without sending', async ({ page }) => {
  await gotoConnected(page);
  await selectAndScan(page, 'ultralight');
  await openTab(page, 'edit');

  await page.getByTestId('input-page').fill('2');
  await page.getByTestId('input-page-data').fill(NEW_PAGE_DATA);
  await page.getByTestId('btn-write-page').click();

  await expect(page.getByTestId('page-write-error')).toContainText('protected', { timeout: 2000 });
  await expect(page.getByTestId('write-confirm-modal')).not.toBeVisible();
  await expect(page.getByTestId('log')).not.toContainText('WROTE_PAGE');
});

// ── WRONG_CARD_TYPE ─────────────────────────────────────────────────────────

test('WRONG_CARD_TYPE: READ_BLOCK on an Ultralight card surfaces the USE hint', async ({ page }) => {
  await gotoConnected(page);
  await selectAndScan(page, 'ultralight');
  await openTab(page, 'console');

  await page.getByTestId('input-raw').fill('READ_BLOCK 4');
  await page.getByTestId('btn-send-raw').click();

  await expect(page.getByTestId('log')).toContainText('ERR WRONG_CARD_TYPE USE=READ_PAGE', { timeout: 3000 });
  await expect(page.getByTestId('card-panel')).toContainText('WRONG_CARD_TYPE', { timeout: 3000 });
});

// ── ISO_14443_4 ─────────────────────────────────────────────────────────────

test('ISO4: panel shows UID-only / unsupported state', async ({ page }) => {
  await gotoConnected(page);
  await selectAndScan(page, 'iso4');

  await expect(page.getByTestId('card-panel')).toContainText('ISO_14443_4', { timeout: 3000 });
  await expect(page.getByTestId('card-panel')).toContainText('04666BA27A1890', { timeout: 3000 });
  // The unsupported notice lives on the Identify tab.
  await openTab(page, 'identify');
  await expect(page.getByTestId('unsupported-notice')).toBeVisible();
  // Editor sub-groups are hidden for ISO4.
  await openTab(page, 'edit');
  await expect(page.getByTestId('classic-controls')).toBeHidden();
  await expect(page.getByTestId('ultralight-controls')).toBeHidden();
});

test('ISO4: a block read surfaces ERR UNSUPPORTED_CARD (no crash/hang)', async ({ page }) => {
  await gotoConnected(page);
  await selectAndScan(page, 'iso4');
  await openTab(page, 'console');

  await page.getByTestId('input-raw').fill('READ_BLOCK 4');
  await page.getByTestId('btn-send-raw').click();

  await expect(page.getByTestId('log')).toContainText('ERR UNSUPPORTED_CARD TYPE=ISO_14443_4', { timeout: 3000 });
  await expect(page.getByTestId('card-panel')).toContainText('UNSUPPORTED_CARD', { timeout: 3000 });
});

// ── RESCAN ──────────────────────────────────────────────────────────────────

test('RESCAN: applying an interval sends RESCAN <ms> and shows OK', async ({ page }) => {
  await gotoConnected(page);
  await openTab(page, 'read');

  await page.getByTestId('input-rescan').fill('250');
  await page.getByTestId('btn-rescan').click();

  await expect(page.getByTestId('log')).toContainText('> RESCAN 250', { timeout: 3000 });
  await expect(page.getByTestId('log')).toContainText('OK RESCAN 250', { timeout: 3000 });
});

test('RESCAN-driven repeat: auto-read fires again when the mock emits a second EVENT', async ({ page }) => {
  await page.goto('http://localhost:4188/PiPicoRFIDExperiments/?mock=1');
  await openTab(page, 'read');
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  const log = page.getByTestId('log');
  await expect.poll(async () => ((await log.textContent()) ?? '').match(/> READ_BLOCK/g)?.length ?? 0).toBe(1);

  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));
  await expect.poll(
    async () => ((await log.textContent()) ?? '').match(/> READ_BLOCK/g)?.length ?? 0,
    { timeout: 3000 },
  ).toBe(2);
});
