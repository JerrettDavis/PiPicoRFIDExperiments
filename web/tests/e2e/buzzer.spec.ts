import { test, expect } from '@playwright/test';
import { gotoConnected, openTab } from './_helpers.js';

test.beforeEach(async ({ page }) => {
  await gotoConnected(page);
  await openTab(page, 'read');
});

test('Buzzer defaults ON and is pushed to firmware on connect', async ({ page }) => {
  await expect(page.getByTestId('toggle-buzzer')).toBeChecked();
  // Connect pushed the default ON state.
  await expect(page.getByTestId('log')).toContainText('OK BUZZER ON', { timeout: 3000 });
});

test('Toggling buzzer OFF then ON sends BUZZER OFF / BUZZER ON', async ({ page }) => {
  const log = page.getByTestId('log');

  await page.getByTestId('toggle-buzzer').uncheck();
  await expect(page.getByTestId('toggle-buzzer')).not.toBeChecked();
  await expect(log).toContainText('OK BUZZER OFF', { timeout: 3000 });

  await page.getByTestId('toggle-buzzer').check();
  await expect(page.getByTestId('toggle-buzzer')).toBeChecked();
  await expect(log).toContainText('OK BUZZER ON', { timeout: 3000 });
});

test('Test Beep button plays the CONFIGURED beep (UI defaults pushed on connect: 1500/200)', async ({ page }) => {
  // On connect the UI pushes BEEPCFG 1500 200, so the configured beep is 1500/200.
  await page.getByTestId('btn-beep').click();
  await expect(page.getByTestId('log')).toContainText('OK BEEP 1500 200', { timeout: 3000 });
});

test('Beep config is pushed on connect with the UI defaults (1500/200)', async ({ page }) => {
  await expect(page.getByTestId('log')).toContainText('OK BEEPCFG 1500 200', { timeout: 3000 });
});

test('Applying a new freq/ms sends BEEPCFG and the configured beep updates', async ({ page }) => {
  const log = page.getByTestId('log');

  await page.getByTestId('input-beep-freq').fill('800');
  await page.getByTestId('input-beep-ms').fill('50');
  await page.getByTestId('btn-beepcfg').click();
  await expect(log).toContainText('> BEEPCFG 800 50', { timeout: 3000 });
  await expect(log).toContainText('OK BEEPCFG 800 50', { timeout: 3000 });

  // BEEP now plays the newly configured params.
  await page.getByTestId('btn-beep').click();
  await expect(log).toContainText('OK BEEP 800 50', { timeout: 3000 });
});

test('Out-of-range freq/ms surfaces ERR BAD_BEEP and does not change the config', async ({ page }) => {
  const log = page.getByTestId('log');

  // freq below 100 → invalid.
  await page.getByTestId('input-beep-freq').fill('50');
  await page.getByTestId('input-beep-ms').fill('200');
  await page.getByTestId('btn-beepcfg').click();
  await expect(log).toContainText('ERR BAD_BEEP', { timeout: 3000 });

  // The earlier-pushed valid config (1500/200) still governs BEEP.
  await page.getByTestId('btn-beep').click();
  await expect(log).toContainText('OK BEEP 1500 200', { timeout: 3000 });
});
