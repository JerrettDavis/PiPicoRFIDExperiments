import { test, expect, type Page } from '@playwright/test';
import { gotoConnected, openTab, setCard } from './_helpers.js';

async function readClassicMap(page: Page): Promise<void> {
  await setCard(page, 'classic');
  await openTab(page, 'read');
  await page.getByTestId('btn-scan').click();
  await page.getByTestId('btn-read-fullmap').click();
  await expect(page.getByTestId('memmap')).toBeVisible({ timeout: 5000 });
}

test('Hex/ASCII toggle flips block 4 to ASCII "Hello from Pico!"', async ({ page }) => {
  await gotoConnected(page);
  await readClassicMap(page);

  // Initially hex is visible, ascii hidden.
  await expect(page.getByTestId('memmap-hex-4')).toBeVisible();
  await expect(page.getByTestId('memmap-ascii-4')).toBeHidden();

  // The ASCII cell content (display-only) decodes to the seeded message.
  await expect(page.getByTestId('memmap-ascii-4')).toContainText('Hello from Pico!');

  // Toggle to ASCII.
  await page.getByTestId('toggle-hexascii').click();
  await expect(page.getByTestId('toggle-hexascii')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('memmap-ascii-4')).toBeVisible();
  await expect(page.getByTestId('memmap-hex-4')).toBeHidden();
});

test('Non-printable bytes render as "." in ASCII view (block 5 = all zeros)', async ({ page }) => {
  await gotoConnected(page);
  await readClassicMap(page);

  // Block 5 is all-zero (non-printable) → 16 dots.
  await expect(page.getByTestId('memmap-ascii-5')).toHaveText('.'.repeat(16));
});

test('Hex/ASCII view mode persists across a tab switch', async ({ page }) => {
  await gotoConnected(page);
  await readClassicMap(page);

  await page.getByTestId('toggle-hexascii').click();
  await expect(page.getByTestId('toggle-hexascii')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => sessionStorage.getItem('rfid.viewMode'))).toBe('ascii');

  // Switch away and back; the toggle state persists.
  await openTab(page, 'edit');
  await openTab(page, 'read');
  await expect(page.getByTestId('toggle-hexascii')).toHaveAttribute('aria-pressed', 'true');
  // ASCII cell still visible (mode preserved).
  await expect(page.getByTestId('memmap-ascii-4')).toBeVisible();
});
