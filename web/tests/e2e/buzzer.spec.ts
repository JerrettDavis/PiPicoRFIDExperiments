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

test('Test Beep button logs OK BEEP with default freq/ms', async ({ page }) => {
  await page.getByTestId('btn-beep').click();
  await expect(page.getByTestId('log')).toContainText('OK BEEP 2700 120', { timeout: 3000 });
});
