import { test, expect, type Page } from '@playwright/test';
import { URL, openTab } from './_helpers.js';

const SEEDED_BLOCK4 = '48656C6C6F2066726F6D205069636F21';
const SEEDED_PAGE4 = '48656C6C';

async function readBlockCount(page: Page): Promise<number> {
  const text = (await page.getByTestId('log').textContent()) ?? '';
  return (text.match(/> READ_BLOCK/g) ?? []).length;
}

async function readPageCount(page: Page): Promise<number> {
  const text = (await page.getByTestId('log').textContent()) ?? '';
  return (text.match(/> READ_PAGE/g) ?? []).length;
}

async function scanCount(page: Page): Promise<number> {
  const text = (await page.getByTestId('log').textContent()) ?? '';
  return (text.match(/> SCAN/g) ?? []).length;
}

test.beforeEach(async ({ page }) => {
  await page.goto(URL);
  // Read tab is enabled on a fresh load (disabling only follows a disconnect).
  await openTab(page, 'read');
});

test('(a) auto-read ON + connect auto-populates card panel and reads seeded block (no clicks)', async ({ page }) => {
  await page.getByTestId('toggle-autoread').check();
  await expect(page.getByTestId('toggle-autoread')).toBeChecked();

  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  const panel = page.getByTestId('card-panel');
  await expect(panel).toContainText('DEADBEEF', { timeout: 3000 });
  await expect(panel).toContainText('MIFARE_1K', { timeout: 3000 });
  await expect(panel).toContainText(SEEDED_BLOCK4, { timeout: 3000 });

  await expect.poll(() => readBlockCount(page)).toBe(1);
});

test('(b) auto-read OFF + CARD_PRESENT event triggers no auto read', async ({ page }) => {
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
  await expect(page.getByTestId('log')).toContainText('EVENT CARD_PRESENT UID=DEADBEEF', { timeout: 3000 });

  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));
  await expect(page.getByTestId('log')).toContainText('EVENT CARD_PRESENT UID=DEADBEEF');

  await page.waitForTimeout(300);
  expect(await readBlockCount(page)).toBe(0);
  expect(await scanCount(page)).toBe(0);
  await expect(page.getByTestId('card-panel')).not.toContainText(SEEDED_BLOCK4);
});

test('(c) v0.2 model: one read per received CARD_PRESENT event', async ({ page }) => {
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  await expect.poll(() => readBlockCount(page)).toBe(1);

  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));
  await expect.poll(() => readBlockCount(page), { timeout: 3000 }).toBe(2);

  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));
  await expect.poll(() => readBlockCount(page), { timeout: 3000 }).toBe(3);
});

test('(d) inFlight guard: an overlapping event does not start a second concurrent read', async ({ page }) => {
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  await expect.poll(() => readBlockCount(page)).toBe(1);

  await page.evaluate(() => {
    window.__mockEmitCardPresent!('DEADBEEF');
    window.__mockEmitCardPresent!('DEADBEEF');
  });

  await expect.poll(() => readBlockCount(page)).toBe(2);
  await expect
    .poll(() => readBlockCount(page).then(n => n <= 2), { timeout: 1000, intervals: [100] })
    .toBe(true);
  expect(await scanCount(page)).toBe(2);
});

test('(e) type-aware auto-read: Ultralight card auto-reads a PAGE, not a block', async ({ page }) => {
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
  await expect.poll(() => readBlockCount(page)).toBe(1);

  await page.evaluate(() => window.__mockSetCard!('ultralight'));
  await page.evaluate(() => window.__mockEmitCardPresent!('04A1B2C3D4E5F6'));

  await expect.poll(() => readPageCount(page), { timeout: 3000 }).toBe(1);
  await expect(page.getByTestId('card-panel')).toContainText(SEEDED_PAGE4, { timeout: 3000 });
  expect(await readBlockCount(page)).toBe(1);
});

test('(f) type-aware auto-read: ISO4 card scans only (no block/page read)', async ({ page }) => {
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
  await expect.poll(() => readBlockCount(page)).toBe(1);

  await page.evaluate(() => window.__mockSetCard!('iso4'));
  await page.evaluate(() => window.__mockEmitCardPresent!('04666BA27A1890'));

  await expect(page.getByTestId('card-panel')).toContainText('ISO_14443_4', { timeout: 3000 });
  await page.waitForTimeout(300);
  expect(await readBlockCount(page)).toBe(1);
  expect(await readPageCount(page)).toBe(0);
});
