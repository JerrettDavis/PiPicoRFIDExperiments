import { test, expect, type Page } from '@playwright/test';

const URL = 'http://localhost:4188/PiPicoRFIDExperiments/?mock=1';
const SEEDED_BLOCK4 = '48656C6C6F2066726F6D205069636F21';
const SEEDED_PAGE4 = '48656C6C';

// Count how many READ_BLOCK commands were sent (each classic auto-read emits one).
async function readBlockCount(page: Page): Promise<number> {
  const text = (await page.getByTestId('log').textContent()) ?? '';
  return (text.match(/> READ_BLOCK/g) ?? []).length;
}

// Count READ_PAGE commands (each ultralight auto-read emits one).
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

  // Exactly one auto-read happened from the single boot CARD_PRESENT.
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

  // Boot emitted one CARD_PRESENT -> one auto-read.
  await expect.poll(() => readBlockCount(page)).toBe(1);

  // Each subsequent EVENT triggers another read (no same-UID suppression).
  // Inject sequentially, waiting for each read to land so the inFlight guard
  // does not drop them.
  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));
  await expect.poll(() => readBlockCount(page), { timeout: 3000 }).toBe(2);

  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));
  await expect.poll(() => readBlockCount(page), { timeout: 3000 }).toBe(3);
});

test('(d) inFlight guard: an overlapping event does not start a second concurrent read', async ({ page }) => {
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  // Boot -> one read. Wait for it to settle.
  await expect.poll(() => readBlockCount(page)).toBe(1);

  // Fire two events in the SAME microtask burst. The first starts a read and
  // sets inFlight; the second arrives while inFlight and is dropped. The mock
  // resolves quickly, so we expect exactly ONE additional read, not two.
  await page.evaluate(() => {
    window.__mockEmitCardPresent!('DEADBEEF');
    window.__mockEmitCardPresent!('DEADBEEF');
  });

  // Robust (not sleep-based): wait until the single additional read lands...
  await expect.poll(() => readBlockCount(page)).toBe(2);
  // ...then assert the count NEVER exceeds 2 (the dropped event must not have
  // produced a 3rd read). This poll keeps re-sampling the running maximum for
  // its full timeout, so a late leaked read would flip it to false and fail.
  await expect
    .poll(() => readBlockCount(page).then(n => n <= 2), { timeout: 1000, intervals: [100] })
    .toBe(true);
  // Each runAutoRead issues exactly one SCAN: boot(1) + one guarded read(1) = 2.
  // A leaked third read would mean a 3rd SCAN.
  expect(await scanCount(page)).toBe(2);
});

test('(e) type-aware auto-read: Ultralight card auto-reads a PAGE, not a block', async ({ page }) => {
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
  // Boot is the classic card -> one block read.
  await expect.poll(() => readBlockCount(page)).toBe(1);

  // Switch the present card to Ultralight, then a fresh EVENT.
  await page.evaluate(() => window.__mockSetCard!('ultralight'));
  await page.evaluate(() => window.__mockEmitCardPresent!('04A1B2C3D4E5F6'));

  // Auto-read should now issue a READ_PAGE (type-aware), not another READ_BLOCK.
  await expect.poll(() => readPageCount(page), { timeout: 3000 }).toBe(1);
  await expect(page.getByTestId('card-panel')).toContainText(SEEDED_PAGE4, { timeout: 3000 });
  // No additional block read happened for the UL card.
  expect(await readBlockCount(page)).toBe(1);
});

test('(f) type-aware auto-read: ISO4 card scans only (no block/page read)', async ({ page }) => {
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
  await expect.poll(() => readBlockCount(page)).toBe(1);

  await page.evaluate(() => window.__mockSetCard!('iso4'));
  await page.evaluate(() => window.__mockEmitCardPresent!('04666BA27A1890'));

  // The scan runs (panel shows ISO_14443_4) but no block/page read is issued.
  await expect(page.getByTestId('card-panel')).toContainText('ISO_14443_4', { timeout: 3000 });
  await page.waitForTimeout(300);
  expect(await readBlockCount(page)).toBe(1); // unchanged from boot
  expect(await readPageCount(page)).toBe(0);
});
