import { test, expect } from '@playwright/test';
import { gotoConnected, openTab } from './_helpers.js';

test.beforeEach(async ({ page }) => {
  await gotoConnected(page, { noConnect: true });
});

test('Connect sets status to Connected with connected dot', async ({ page }) => {
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
  await expect(page.getByTestId('status-dot')).toHaveClass(/connected/);
});

test('Boot banner READY and CARD_PRESENT UID appear in log; Scan shows UID in card panel', async ({ page }) => {
  await page.getByTestId('btn-connect').click();
  const log = page.getByTestId('log');
  await expect(log).toContainText('READY RP2040_RFID_USB 0.3.0', { timeout: 3000 });
  await expect(log).toContainText('EVENT CARD_PRESENT UID=DEADBEEF', { timeout: 3000 });

  // Scan and check card panel (both live on the Read tab).
  await openTab(page, 'read');
  await page.getByTestId('btn-scan').click();
  await expect(page.getByTestId('card-panel')).toContainText('DEADBEEF', { timeout: 3000 });
});

test('Ping logs OK PONG and shows success badge', async ({ page }) => {
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');

  await openTab(page, 'read');
  await page.getByTestId('btn-ping').click();
  await expect(page.getByTestId('log')).toContainText('OK PONG', { timeout: 3000 });
  await expect(page.getByTestId('badge-success')).toBeVisible({ timeout: 3000 });
});
