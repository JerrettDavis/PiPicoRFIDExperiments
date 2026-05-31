import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('http://localhost:4188/PiPicoRFIDExperiments/?mock=1');
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
});

test('Scan shows UID=DEADBEEF, SAK=0x08, TYPE=MIFARE_1K in card panel', async ({ page }) => {
  await page.getByTestId('btn-scan').click();
  const panel = page.getByTestId('card-panel');
  await expect(panel).toContainText('DEADBEEF', { timeout: 3000 });
  await expect(panel).toContainText('0x08', { timeout: 3000 });
  await expect(panel).toContainText('MIFARE_1K', { timeout: 3000 });
});

test('Read block 4 returns seeded data and shows success badge', async ({ page }) => {
  await page.getByTestId('input-block').fill('4');
  await page.getByTestId('btn-read').click();
  await expect(page.getByTestId('card-panel')).toContainText('48656C6C6F2066726F6D205069636F21', { timeout: 3000 });
  await expect(page.getByTestId('badge-success')).toBeVisible({ timeout: 3000 });
});

test('Read block 5 returns 32 zeros', async ({ page }) => {
  await page.getByTestId('input-block').fill('5');
  await page.getByTestId('btn-read').click();
  await expect(page.getByTestId('card-panel')).toContainText('0'.repeat(32), { timeout: 3000 });
  await expect(page.getByTestId('badge-success')).toBeVisible({ timeout: 3000 });
});

test('Dump sector for block 4 shows DUMP_BEGIN, blocks 4-7, DUMP_END in log', async ({ page }) => {
  await page.getByTestId('input-block').fill('4');
  await page.getByTestId('btn-dump').click();
  const log = page.getByTestId('log');
  await expect(log).toContainText('OK DUMP_BEGIN', { timeout: 3000 });
  await expect(log).toContainText('BLOCK=4', { timeout: 3000 });
  await expect(log).toContainText('BLOCK=5', { timeout: 3000 });
  await expect(log).toContainText('BLOCK=6', { timeout: 3000 });
  await expect(log).toContainText('BLOCK=7', { timeout: 3000 });
  await expect(log).toContainText('OK DUMP_END', { timeout: 3000 });
});
