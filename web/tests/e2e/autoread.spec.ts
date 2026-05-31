import { test, expect, type Page } from '@playwright/test';

const URL = 'http://localhost:4188/PiPicoRFIDExperiments/?mock=1';
const SEEDED_BLOCK4 = '48656C6C6F2066726F6D205069636F21';

// Count how many times a READ_BLOCK command was sent (each auto-read emits one).
async function readBlockCount(page: Page): Promise<number> {
  const text = (await page.getByTestId('log').textContent()) ?? '';
  return (text.match(/READ_BLOCK/g) ?? []).length;
}

async function scanCount(page: Page): Promise<number> {
  const text = (await page.getByTestId('log').textContent()) ?? '';
  // Match the tx SCAN line; avoid matching the button label or response text.
  return (text.match(/> SCAN/g) ?? []).length;
}

test.beforeEach(async ({ page }) => {
  await page.goto(URL);
});

test('(a) auto-read ON + connect auto-populates card panel and reads seeded block (no clicks)', async ({ page }) => {
  // Turn auto-read ON BEFORE connecting so the boot CARD_PRESENT triggers it.
  await page.getByTestId('toggle-autoread').check();
  await expect(page.getByTestId('toggle-autoread')).toBeChecked();

  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  // Without any click on Scan/Read, the panel should show the scanned UID...
  const panel = page.getByTestId('card-panel');
  await expect(panel).toContainText('DEADBEEF', { timeout: 3000 });
  await expect(panel).toContainText('MIFARE_1K', { timeout: 3000 });
  // ...and the auto-read of the default block (4) seeded data.
  await expect(panel).toContainText(SEEDED_BLOCK4, { timeout: 3000 });

  // Exactly one auto-read happened from the single boot CARD_PRESENT.
  await expect.poll(() => readBlockCount(page)).toBe(1);
});

test('(b) auto-read OFF + CARD_PRESENT event triggers no auto read', async ({ page }) => {
  // Leave toggle OFF (default).
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
  // Wait for boot CARD_PRESENT to have been processed.
  await expect(page.getByTestId('log')).toContainText('EVENT CARD_PRESENT UID=DEADBEEF', { timeout: 3000 });

  // Inject another CARD_PRESENT explicitly.
  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));
  await expect(page.getByTestId('log')).toContainText('EVENT CARD_PRESENT UID=DEADBEEF');

  // Give any (erroneous) auto-read a chance to run, then assert none happened.
  await page.waitForTimeout(300);
  expect(await readBlockCount(page)).toBe(0);
  expect(await scanCount(page)).toBe(0);
  // Panel still shows nothing was read.
  await expect(page.getByTestId('card-panel')).not.toContainText(SEEDED_BLOCK4);
});

test('(c) debounce: two CARD_PRESENT for the SAME uid back-to-back read only once', async ({ page }) => {
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  // Boot already emitted one CARD_PRESENT(DEADBEEF) -> one auto-read.
  await expect.poll(() => readBlockCount(page)).toBe(1);

  // Two more back-to-back for the SAME uid should NOT trigger more reads
  // (debounced: same uid, card never went absent).
  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));
  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));

  await page.waitForTimeout(300);
  expect(await readBlockCount(page)).toBe(1);
});

test('(d) a CARD_PRESENT for a DIFFERENT uid triggers a fresh auto-read', async ({ page }) => {
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  // Boot CARD_PRESENT(DEADBEEF) -> one auto-read.
  await expect.poll(() => readBlockCount(page)).toBe(1);

  // A different uid must trigger a fresh auto-read immediately.
  await page.evaluate(() => window.__mockEmitCardPresent!('CAFEBABE'));
  await expect.poll(() => readBlockCount(page), { timeout: 3000 }).toBe(2);
});

test('(e) same uid re-presented past the OLD 1s threshold (card never left) does NOT re-read', async ({ page }) => {
  // Regression guard for the absence-window bug: ABSENCE_RESET_MS (now 7000ms)
  // must comfortably exceed a full auto-read. With the old 1000ms value, the
  // absence timer would clear lastUid ~1s after the last CARD_PRESENT, so a
  // same-uid repeat at ~1.2s (the card never actually left) would spuriously
  // re-read. It must NOT.
  await page.getByTestId('toggle-autoread').check();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  // Boot CARD_PRESENT(DEADBEEF) -> exactly one auto-read.
  await expect.poll(() => readBlockCount(page)).toBe(1);

  // Wait past the OLD (buggy) 1000ms threshold without any CARD_PRESENT...
  await page.waitForTimeout(1200);
  // ...then the SAME card (never removed) is seen again.
  await page.evaluate(() => window.__mockEmitCardPresent!('DEADBEEF'));

  // No duplicate read should occur for the same, never-removed card.
  await page.waitForTimeout(400);
  expect(await readBlockCount(page)).toBe(1);
});
