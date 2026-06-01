import { test, expect, type Page } from '@playwright/test';
import { gotoConnected, openTab, setCard } from './_helpers.js';

const NEW_DATA = 'AABBCCDD11223344AABBCCDD11223344';

async function readClassicMap(page: Page): Promise<void> {
  await setCard(page, 'classic');
  await openTab(page, 'read');
  await page.getByTestId('btn-scan').click();
  await page.getByTestId('btn-read-fullmap').click();
  await expect(page.getByTestId('memmap')).toBeVisible({ timeout: 5000 });
}

test('Click memmap-edit-4 → Edit tab with block 4 prefilled → two-step confirm → map updates', async ({ page }) => {
  await gotoConnected(page);
  await readClassicMap(page);

  // From-map edit of block 4.
  await page.getByTestId('memmap-edit-4').click();

  // Switched to Edit tab with block prefilled.
  await expect(page.getByTestId('panel-edit')).toBeVisible();
  await expect(page.getByTestId('input-block')).toHaveValue('4');
  // Data prefilled from the captured image (seeded "Hello from Pico!").
  await expect(page.getByTestId('input-data')).toHaveValue('48656C6C6F2066726F6D205069636F21');

  // Overwrite with new data and run the two-step confirm.
  await page.getByTestId('input-data').fill(NEW_DATA);
  await page.getByTestId('btn-write').click();
  await expect(page.getByTestId('write-confirm-modal')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('confirm-ack').check();
  await page.getByTestId('confirm-step1').click();
  await expect(page.getByTestId('write-confirm-step2')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('confirm-type').fill('4');
  await page.getByTestId('confirm-step2').click();

  // OK WROTE in the log.
  await expect(page.getByTestId('log')).toContainText('OK WROTE BLOCK=4', { timeout: 3000 });

  // The memory-map row 4 updated to the new value (back on Read).
  await openTab(page, 'read');
  await expect(page.getByTestId('memmap-hex-4')).toContainText('AA BB CC DD');
});

test('ASCII view: from-map edit prefills HEX and the sent WRITE command is hex-only (not ASCII)', async ({ page }) => {
  await gotoConnected(page);
  await readClassicMap(page);

  // Toggle the map to ASCII display.
  await page.getByTestId('toggle-hexascii').click();
  await expect(page.getByTestId('toggle-hexascii')).toHaveAttribute('aria-pressed', 'true');
  // Block 4 ASCII cell shows the decoded message...
  await expect(page.getByTestId('memmap-ascii-4')).toContainText('Hello from Pico!');

  // ...but a from-map edit prefills the HEX into the editor, not the ASCII.
  await page.getByTestId('memmap-edit-4').click();
  await expect(page.getByTestId('panel-edit')).toBeVisible();
  await expect(page.getByTestId('input-data')).toHaveValue('48656C6C6F2066726F6D205069636F21');

  // Complete the two-step confirm (unchanged data) and assert the SENT command
  // carries the original HEX bytes, never the ASCII string.
  await page.getByTestId('btn-write').click();
  await page.getByTestId('confirm-ack').check();
  await page.getByTestId('confirm-step1').click();
  await expect(page.getByTestId('write-confirm-step2')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('confirm-type').fill('4');
  await page.getByTestId('confirm-step2').click();

  const log = page.getByTestId('log');
  await expect(log).toContainText('WRITE_BLOCK 4 48656C6C6F2066726F6D205069636F21', { timeout: 3000 });
  await expect(log).not.toContainText('Hello from Pico!');
});

test('memmap-edit-0 (manufacturer) and a trailer edit button are disabled (never reach the editor)', async ({ page }) => {
  await gotoConnected(page);
  await readClassicMap(page);

  await expect(page.getByTestId('memmap-edit-0')).toBeDisabled();
  await expect(page.getByTestId('memmap-edit-3')).toBeDisabled();

  // Clicking a disabled edit button does nothing — Edit tab does not steal focus.
  await page.getByTestId('memmap-edit-0').click({ force: true });
  await expect(page.getByTestId('panel-read')).toBeVisible();
  await expect(page.getByTestId('panel-edit')).toBeHidden();
});
