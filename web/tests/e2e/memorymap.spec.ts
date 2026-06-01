import { test, expect, type Page } from '@playwright/test';
import { gotoConnected, openTab, setCard } from './_helpers.js';

async function readFullMap(page: Page, kind: string): Promise<void> {
  await setCard(page, kind);
  await openTab(page, 'read');
  await page.getByTestId('btn-scan').click();
  await page.getByTestId('btn-read-fullmap').click();
  await expect(page.getByTestId('memmap')).toBeVisible({ timeout: 5000 });
}

test('Classic full map renders sectors 0-15 with block0 MFR, block3 TRAIL, block4 hex data', async ({ page }) => {
  await gotoConnected(page);
  await readFullMap(page, 'classic');

  // Sector headers 0..15 present.
  await expect(page.getByTestId('memmap-sector-head-0')).toBeVisible();
  await expect(page.getByTestId('memmap-sector-head-15')).toBeVisible();

  // Roles.
  await expect(page.getByTestId('memmap-block-0')).toHaveAttribute('data-role', 'manufacturer');
  await expect(page.getByTestId('memmap-block-3')).toHaveAttribute('data-role', 'trailer');
  await expect(page.getByTestId('memmap-block-4')).toHaveAttribute('data-role', 'data');

  // Block 4 seeded hex (space-grouped) contains the "Hello" bytes.
  await expect(page.getByTestId('memmap-hex-4')).toContainText('48 65 6C 6C');

  // Summary capacity text.
  await expect(page.getByTestId('memmap-summary')).toContainText('16 sectors / 64 blocks');
});

test('Classic map edit buttons: block0 and trailers disabled, data blocks enabled', async ({ page }) => {
  await gotoConnected(page);
  await readFullMap(page, 'classic');

  await expect(page.getByTestId('memmap-edit-0')).toBeDisabled();   // manufacturer
  await expect(page.getByTestId('memmap-edit-3')).toBeDisabled();   // trailer
  await expect(page.getByTestId('memmap-edit-4')).toBeEnabled();    // data
});

test('classic-locked shows FAILED sectors 5 and 9 with .failed and disabled edits', async ({ page }) => {
  await gotoConnected(page);
  await readFullMap(page, 'classic-locked');

  const head5 = page.getByTestId('memmap-sector-head-5');
  const head9 = page.getByTestId('memmap-sector-head-9');
  await expect(head5).toHaveClass(/failed/);
  await expect(head9).toHaveClass(/failed/);
  await expect(head5).toContainText('STATUS=FAILED');

  // A failed-sector block row shows the ERR and its edit is disabled.
  await expect(page.getByTestId('memmap-block-20')).toHaveClass(/failed/);
  await expect(page.getByTestId('memmap-block-20')).toContainText('ERR AUTH_FAILED');
  await expect(page.getByTestId('memmap-edit-20')).toBeDisabled();

  // Summary lists the failed sectors.
  await expect(page.getByTestId('memmap-summary')).toContainText('sectors 5, 9');
});

test('Ultralight full map renders page rows with seeded page 4 and protected page edits disabled', async ({ page }) => {
  await gotoConnected(page);
  await readFullMap(page, 'ultralight');

  await expect(page.getByTestId('memmap-page-0')).toBeVisible();
  await expect(page.getByTestId('memmap-page-4')).toBeVisible();
  // Seeded page 4 hex.
  await expect(page.getByTestId('memmap-page-hex-4')).toContainText('48 65 6C 6C');

  // Pages 0-3 are protected (edit disabled); page 4 is editable.
  await expect(page.getByTestId('memmap-edit-page-0')).toBeDisabled();
  await expect(page.getByTestId('memmap-edit-page-3')).toBeDisabled();
  await expect(page.getByTestId('memmap-edit-page-4')).toBeEnabled();

  await expect(page.getByTestId('memmap-summary')).toContainText('pages');
});
