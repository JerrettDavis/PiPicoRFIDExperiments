import { test, expect } from '@playwright/test';

const NEW_DATA = 'AABBCCDD11223344AABBCCDD11223344';

test.beforeEach(async ({ page }) => {
  await page.goto('http://localhost:4188/PiPicoRFIDExperiments/?mock=1');
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
});

// Helper: open write modal with block 4 and NEW_DATA
async function openWriteModal(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('input-block').fill('4');
  await page.getByTestId('input-data').fill(NEW_DATA);
  await page.getByTestId('btn-write').click();
  await expect(page.getByTestId('write-confirm-modal')).toBeVisible({ timeout: 2000 });
}

test('Step1 ack + Continue then Cancel at step2 — no WROTE in log', async ({ page }) => {
  await openWriteModal(page);

  // Step 1: check ack, click Continue
  await page.getByTestId('confirm-ack').check();
  await page.getByTestId('confirm-step1').click();

  // Step 2: Cancel without typing
  await expect(page.getByTestId('write-confirm-step2')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('confirm-cancel').click();

  // Modal closed, no WROTE in log
  await expect(page.getByTestId('write-confirm-modal')).not.toBeVisible();
  await expect(page.getByTestId('log')).not.toContainText('WROTE');
});

test('Full two-step confirm writes block and Read confirms new value', async ({ page }) => {
  await openWriteModal(page);

  // Step 1
  await page.getByTestId('confirm-ack').check();
  await page.getByTestId('confirm-step1').click();

  // Step 2: type exact block number
  await expect(page.getByTestId('write-confirm-step2')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('confirm-type').fill('4');
  await page.getByTestId('confirm-step2').click();

  // WROTE line in log
  await expect(page.getByTestId('log')).toContainText('OK WROTE BLOCK=4', { timeout: 3000 });

  // Read block 4 and confirm new value
  await page.getByTestId('input-block').fill('4');
  await page.getByTestId('btn-read').click();
  await expect(page.getByTestId('card-panel')).toContainText(NEW_DATA, { timeout: 3000 });
});

test('Cancel at step 1 — nothing sent', async ({ page }) => {
  await openWriteModal(page);
  await page.getByTestId('confirm-cancel').click();

  await expect(page.getByTestId('write-confirm-modal')).not.toBeVisible();
  await expect(page.getByTestId('log')).not.toContainText('WRITE_BLOCK');
  await expect(page.getByTestId('log')).not.toContainText('WROTE');
});

test('Write Now button is disabled until typed value exactly equals block number', async ({ page }) => {
  await openWriteModal(page);
  await page.getByTestId('confirm-ack').check();
  await page.getByTestId('confirm-step1').click();

  await expect(page.getByTestId('write-confirm-step2')).toBeVisible({ timeout: 2000 });

  // Initially disabled
  await expect(page.getByTestId('confirm-step2')).toBeDisabled();

  // Wrong value — still disabled
  await page.getByTestId('confirm-type').fill('40');
  await expect(page.getByTestId('confirm-step2')).toBeDisabled();

  // Correct value — enabled
  await page.getByTestId('confirm-type').fill('4');
  await expect(page.getByTestId('confirm-step2')).toBeEnabled();
});

test('Block 3 (sector trailer) shows inline error, modal does not open', async ({ page }) => {
  await page.getByTestId('input-block').fill('3');
  await page.getByTestId('input-data').fill(NEW_DATA);
  await page.getByTestId('btn-write').click();

  await expect(page.getByTestId('write-error')).toContainText('sector trailer', { timeout: 2000 });
  await expect(page.getByTestId('write-confirm-modal')).not.toBeVisible();
});

test('Data of 30 chars shows inline error, modal does not open', async ({ page }) => {
  await page.getByTestId('input-block').fill('4');
  // 30 hex chars (invalid — needs 32)
  await page.getByTestId('input-data').fill('AABBCCDD11223344AABBCCDD1122');
  await page.getByTestId('btn-write').click();

  await expect(page.getByTestId('write-error')).toContainText('32 hex', { timeout: 2000 });
  await expect(page.getByTestId('write-confirm-modal')).not.toBeVisible();
});

// ── 4K trailer geometry (B2 regression): upper sectors are 16 blocks ─────────

for (const trailer of [143, 159, 175, 191, 207, 223, 239, 255]) {
  test(`4K trailer block ${trailer} is caught client-side, modal does not open`, async ({ page }) => {
    await page.getByTestId('input-block').fill(String(trailer));
    await page.getByTestId('input-data').fill(NEW_DATA);
    await page.getByTestId('btn-write').click();

    await expect(page.getByTestId('write-error')).toContainText('sector trailer', { timeout: 2000 });
    await expect(page.getByTestId('write-confirm-modal')).not.toBeVisible();
    // Crucially: the confirm modal never opened, so no WRITE could be completed.
    await expect(page.getByTestId('log')).not.toContainText('WROTE');
  });
}

test('4K upper-area data block 144 is NOT blocked client-side (modal opens)', async ({ page }) => {
  // 144 is the first data block of the first 16-block sector (128–143); only
  // 143 is the trailer. The client must allow it (modal opens for confirm).
  await page.getByTestId('input-block').fill('144');
  await page.getByTestId('input-data').fill(NEW_DATA);
  await page.getByTestId('btn-write').click();

  await expect(page.getByTestId('write-confirm-modal')).toBeVisible({ timeout: 2000 });
  await expect(page.getByTestId('write-error')).not.toContainText('sector trailer');
});

// ── Raw command input routes WRITE_BLOCK through the two-step confirm ─────────

test('Raw WRITE_BLOCK opens the confirm modal (does not send immediately)', async ({ page }) => {
  await page.getByTestId('input-raw').fill(`WRITE_BLOCK 4 ${NEW_DATA}`);
  await page.getByTestId('btn-send-raw').click();

  // Modal opens; nothing has been written yet
  await expect(page.getByTestId('write-confirm-modal')).toBeVisible({ timeout: 2000 });
  await expect(page.getByTestId('log')).not.toContainText('WROTE');
});

test('Raw WRITE_BLOCK cancelled at step 1 sends nothing', async ({ page }) => {
  await page.getByTestId('input-raw').fill(`WRITE_BLOCK 4 ${NEW_DATA}`);
  await page.getByTestId('btn-send-raw').click();
  await expect(page.getByTestId('write-confirm-modal')).toBeVisible({ timeout: 2000 });

  await page.getByTestId('confirm-cancel').click();

  await expect(page.getByTestId('write-confirm-modal')).not.toBeVisible();
  await expect(page.getByTestId('log')).not.toContainText('WROTE');
  await expect(page.getByTestId('log')).not.toContainText('WRITE_BLOCK');
});

test('Raw WRITE_BLOCK completing both steps sends it and OK WROTE appears', async ({ page }) => {
  await page.getByTestId('input-raw').fill(`WRITE_BLOCK 4 ${NEW_DATA}`);
  await page.getByTestId('btn-send-raw').click();
  await expect(page.getByTestId('write-confirm-modal')).toBeVisible({ timeout: 2000 });

  // Step 1
  await page.getByTestId('confirm-ack').check();
  await page.getByTestId('confirm-step1').click();

  // Step 2
  await expect(page.getByTestId('write-confirm-step2')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('confirm-type').fill('4');
  await page.getByTestId('confirm-step2').click();

  await expect(page.getByTestId('log')).toContainText('OK WROTE BLOCK=4', { timeout: 3000 });
});
