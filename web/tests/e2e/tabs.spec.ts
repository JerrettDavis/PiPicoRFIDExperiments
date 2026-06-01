import { test, expect } from '@playwright/test';
import { URL, gotoConnected, openTab } from './_helpers.js';

const DATA_TABS = ['read', 'edit', 'clone', 'identify'] as const;

test('Default tab is Read; switching shows/hides the correct panel', async ({ page }) => {
  await gotoConnected(page);

  // Default active tab is Read.
  await expect(page.getByTestId('panel-read')).toBeVisible();
  await expect(page.getByTestId('panel-edit')).toBeHidden();

  await openTab(page, 'edit');
  await expect(page.getByTestId('panel-read')).toBeHidden();
  await expect(page.getByTestId('panel-edit')).toBeVisible();

  await openTab(page, 'console');
  await expect(page.getByTestId('panel-edit')).toBeHidden();
  await expect(page.getByTestId('panel-console')).toBeVisible();
});

test('Console is always enabled; the 4 data tabs are disabled pre-connect and enabled after', async ({ page }) => {
  await page.goto(URL);
  // Console is always enabled.
  await expect(page.getByTestId('tab-console')).toBeEnabled();

  // Connect → all data tabs enabled.
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
  for (const t of DATA_TABS) {
    await expect(page.getByTestId(`tab-${t}`)).toBeEnabled();
  }

  // Disconnect → the 4 data tabs become disabled, Console stays enabled.
  await page.getByTestId('btn-disconnect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Disconnected');
  for (const t of DATA_TABS) {
    await expect(page.getByTestId(`tab-${t}`)).toBeDisabled();
  }
  await expect(page.getByTestId('tab-console')).toBeEnabled();
});

test('Disconnect while on a data tab falls back to Console', async ({ page }) => {
  await gotoConnected(page);
  await openTab(page, 'edit');
  await expect(page.getByTestId('panel-edit')).toBeVisible();

  await page.getByTestId('btn-disconnect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Disconnected');

  // Active tab fell back to Console.
  await expect(page.getByTestId('panel-console')).toBeVisible();
  await expect(page.getByTestId('panel-edit')).toBeHidden();
});

test('Active tab persists in sessionStorage across reload', async ({ page }) => {
  await gotoConnected(page);
  await openTab(page, 'clone');
  expect(await page.evaluate(() => sessionStorage.getItem('rfid.activeTab'))).toBe('clone');

  // Reload + reconnect; the persisted tab is restored (it's enabled after connect).
  await page.reload();
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
  await expect(page.getByTestId('panel-clone')).toBeVisible();
});

test('Switching tabs never opens a confirm modal', async ({ page }) => {
  await gotoConnected(page);
  for (const t of ['edit', 'clone', 'identify', 'console', 'read'] as const) {
    await openTab(page, t);
    await expect(page.getByTestId('write-confirm-modal')).not.toBeVisible();
    await expect(page.getByTestId('clone-confirm-modal')).not.toBeVisible();
  }
});
