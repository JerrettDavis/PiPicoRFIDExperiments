import { test, expect, type Page } from '@playwright/test';

const URL = 'http://localhost:4188/PiPicoRFIDExperiments/?mock=1';

async function connect(page: Page): Promise<void> {
  await page.goto(URL);
  await page.getByTestId('btn-connect').click();
  await expect(page.getByTestId('status-text')).toHaveText('Connected');
}

async function setCard(page: Page, kind: string): Promise<void> {
  await page.evaluate((k) => window.__mockSetCard!(k as never), kind);
}

// Read the source image, asserting the image panel populated.
async function readSource(page: Page): Promise<void> {
  await page.getByTestId('btn-clone-read').click();
  await expect(page.getByTestId('clone-image-panel')).not.toContainText('No source image', { timeout: 5000 });
}

async function detectTarget(page: Page): Promise<void> {
  await page.getByTestId('btn-clone-detect').click();
  await expect(page.getByTestId('clone-target-panel')).not.toContainText('No target detected', { timeout: 5000 });
}

// Drive the two-step clone confirm to completion.
async function confirmCloneFlow(page: Page): Promise<void> {
  await expect(page.getByTestId('clone-confirm-modal')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('clone-confirm-ack').check();
  await page.getByTestId('clone-confirm-step1').click();
  await expect(page.getByTestId('clone-confirm-step2')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('clone-confirm-type').fill('CLONE');
  await page.getByTestId('clone-confirm-step2').click();
}

// ── Classic full dump incl. FAILED sector ────────────────────────────────────

test('Classic full dump includes a FAILED sector (not skipped) and dictionary-key sectors read OK', async ({ page }) => {
  await connect(page);
  await setCard(page, 'classic-locked');
  // Scan so the clone panel is visible for the classic family.
  await page.getByTestId('btn-scan').click();
  await readSource(page);

  const panel = page.getByTestId('clone-image-panel');
  // 16 sectors total.
  await expect(panel).toContainText('SECTOR 0', { timeout: 3000 });
  await expect(panel).toContainText('SECTOR 15', { timeout: 3000 });
  // Sectors 5 and 9 are FAILED (present in the image, not skipped).
  await expect(panel).toContainText('SECTOR 5 KEY=------------ KEYTYPE=NONE STATUS=FAILED');
  await expect(panel).toContainText('SECTOR 9 KEY=------------ KEYTYPE=NONE STATUS=FAILED');
  // Dictionary-key sectors read OK with the dict key.
  await expect(panel).toContainText('SECTOR 1 KEY=A0A1A2A3A4A5 KEYTYPE=A STATUS=OK');
  // A failed sector still lists its blocks with ERR.
  await expect(panel).toContainText('BLOCK 20: ERR AUTH_FAILED');
});

// ── Clone → Gen1a ────────────────────────────────────────────────────────────

test('Clone to a Gen1a magic card clones the UID (METHOD=GEN1A)', async ({ page }) => {
  await connect(page);
  // Source: normal classic.
  await setCard(page, 'classic');
  await page.getByTestId('btn-scan').click();
  await readSource(page);

  // Target: Gen1a magic.
  await setCard(page, 'classic-gen1a');
  await detectTarget(page);
  await expect(page.getByTestId('clone-target-panel')).toContainText('GEN=GEN1A');

  await page.getByTestId('btn-clone-write').click();
  await confirmCloneFlow(page);

  const summary = page.getByTestId('clone-summary');
  await expect(summary).toContainText('UID cloned: YES (GEN1A)', { timeout: 5000 });
  await expect(page.getByTestId('log')).toContainText('CLONE_UID METHOD=GEN1A');
});

// ── Clone → Gen2 ─────────────────────────────────────────────────────────────

test('Clone to a Gen2 magic card clones the UID (METHOD=GEN2)', async ({ page }) => {
  await connect(page);
  await setCard(page, 'classic');
  await page.getByTestId('btn-scan').click();
  await readSource(page);

  await setCard(page, 'classic-gen2');
  await detectTarget(page);
  await expect(page.getByTestId('clone-target-panel')).toContainText('GEN=GEN2');

  await page.getByTestId('btn-clone-write').click();
  await confirmCloneFlow(page);

  await expect(page.getByTestId('clone-summary')).toContainText('UID cloned: YES (GEN2)', { timeout: 5000 });
});

// ── Clone → NORMAL ───────────────────────────────────────────────────────────

test('Clone to a NORMAL classic card writes data but does not clone UID', async ({ page }) => {
  await connect(page);
  await setCard(page, 'classic');
  await page.getByTestId('btn-scan').click();
  await readSource(page);

  // Target is also a normal classic (no magic).
  await detectTarget(page);

  await page.getByTestId('btn-clone-write').click();
  await confirmCloneFlow(page);

  const summary = page.getByTestId('clone-summary');
  await expect(summary).toContainText('UID cloned: NO', { timeout: 5000 });
  await expect(summary).toContainText('NORMAL_CARD');
  // Data WAS written (written count > 0), UID just wasn't.
  await expect(summary).toContainText('Written:');
  // No CLONE_UID was attempted on a normal card.
  await expect(page.getByTestId('log')).not.toContainText('CLONE_UID METHOD');
});

// ── Clone confirmation gating ─────────────────────────────────────────────────

test('Clone write gating: NO write before confirm; cancel at step 1 writes nothing', async ({ page }) => {
  await connect(page);
  await setCard(page, 'classic');
  await page.getByTestId('btn-scan').click();
  await readSource(page);
  await setCard(page, 'classic-gen2');
  await detectTarget(page);

  await page.getByTestId('btn-clone-write').click();
  await expect(page.getByTestId('clone-confirm-modal')).toBeVisible({ timeout: 2000 });
  // Nothing written before any confirm.
  await expect(page.getByTestId('log')).not.toContainText('WRITE_BLOCK_RAW');
  await expect(page.getByTestId('log')).not.toContainText('OK WROTE');

  // Cancel at step 1 → nothing written.
  await page.getByTestId('clone-confirm-cancel').click();
  await expect(page.getByTestId('clone-confirm-modal')).not.toBeVisible();
  await page.waitForTimeout(200);
  await expect(page.getByTestId('log')).not.toContainText('WRITE_BLOCK_RAW');
  await expect(page.getByTestId('log')).not.toContainText('OK WROTE');
});

test('Clone write gating: cancel at step 2 writes nothing', async ({ page }) => {
  await connect(page);
  await setCard(page, 'classic');
  await page.getByTestId('btn-scan').click();
  await readSource(page);
  await setCard(page, 'classic-gen2');
  await detectTarget(page);

  await page.getByTestId('btn-clone-write').click();
  await page.getByTestId('clone-confirm-ack').check();
  await page.getByTestId('clone-confirm-step1').click();
  await expect(page.getByTestId('clone-confirm-step2')).toBeVisible({ timeout: 2000 });
  await page.getByTestId('clone-confirm-cancel').click();

  await expect(page.getByTestId('clone-confirm-modal')).not.toBeVisible();
  await page.waitForTimeout(200);
  await expect(page.getByTestId('log')).not.toContainText('WRITE_BLOCK_RAW');
  await expect(page.getByTestId('log')).not.toContainText('OK WROTE');
});

test('clone-confirm-step2 button is disabled until the input equals exactly CLONE', async ({ page }) => {
  await connect(page);
  await setCard(page, 'classic');
  await page.getByTestId('btn-scan').click();
  await readSource(page);
  await setCard(page, 'classic-gen2');
  await detectTarget(page);

  await page.getByTestId('btn-clone-write').click();
  await page.getByTestId('clone-confirm-ack').check();
  await page.getByTestId('clone-confirm-step1').click();
  await expect(page.getByTestId('clone-confirm-step2')).toBeVisible({ timeout: 2000 });

  await expect(page.getByTestId('clone-confirm-step2')).toBeDisabled();
  await page.getByTestId('clone-confirm-type').fill('clone'); // wrong case
  await expect(page.getByTestId('clone-confirm-step2')).toBeDisabled();
  await page.getByTestId('clone-confirm-type').fill('CLON');
  await expect(page.getByTestId('clone-confirm-step2')).toBeDisabled();
  await page.getByTestId('clone-confirm-type').fill('CLONE');
  await expect(page.getByTestId('clone-confirm-step2')).toBeEnabled();
});

// ── NTAG magic page clone ─────────────────────────────────────────────────────

test('NTAG magic clone writes pages 0-2 (uidCloned via magic)', async ({ page }) => {
  await connect(page);
  // Source: a magic NTAG so its image has pages 0-2.
  await setCard(page, 'ntag-magic');
  await page.getByTestId('btn-scan').click();
  await readSource(page);

  // Target also magic NTAG.
  await detectTarget(page);

  await page.getByTestId('btn-clone-write').click();
  await confirmCloneFlow(page);

  const summary = page.getByTestId('clone-summary');
  await expect(summary).toContainText('UID cloned: YES (UL_MAGIC)', { timeout: 5000 });
  // Pages 0,1,2 written via WRITE_PAGE_RAW.
  await expect(page.getByTestId('log')).toContainText('WRITE_PAGE_RAW 0');
  await expect(page.getByTestId('log')).toContainText('WRITE_PAGE_RAW 2');
});

test('NTAG normal clone: pages 0-2 fail, data pages still written', async ({ page }) => {
  await connect(page);
  // Source: a magic NTAG (image has pages 0-2 present).
  await setCard(page, 'ntag-magic');
  await page.getByTestId('btn-scan').click();
  await readSource(page);

  // Target: a NORMAL ultralight (no magic) — pages 0-2 must fail.
  await setCard(page, 'ultralight');
  await detectTarget(page);

  await page.getByTestId('btn-clone-write').click();
  await confirmCloneFlow(page);

  const summary = page.getByTestId('clone-summary');
  await expect(summary).toContainText('Written:', { timeout: 5000 });
  await expect(summary).toContainText('UID cloned: NO');
  // Pages 0-2 collected as failures (REFUSE_UL_CASCADE_BYTE), not aborting.
  await expect(summary).toContainText('FAILED addr 0');
  // Data pages (>=4) still attempted.
  await expect(page.getByTestId('log')).toContainText('WRITE_PAGE_RAW 4');
});

// ── ISO4 identify ─────────────────────────────────────────────────────────────

test('ISO4 identify: iso4-panel + clone-impossible notice + ATS shows 0675F7B102', async ({ page }) => {
  await connect(page);
  await setCard(page, 'iso4-desfire');
  await page.getByTestId('btn-scan').click();

  await expect(page.getByTestId('iso4-panel')).toBeVisible();
  await expect(page.getByTestId('clone-impossible-notice')).toBeVisible();
  await expect(page.getByTestId('clone-impossible-notice')).toContainText('not possible');
  // The clone panel must be hidden for ISO4.
  await expect(page.getByTestId('clone-panel')).toBeHidden();

  await page.getByTestId('btn-ats-read').click();
  await expect(page.getByTestId('ats-display')).toContainText('0675F7B102', { timeout: 3000 });
});

test('ISO4 APDU 60 returns RESP=04010133001605 SW=9100', async ({ page }) => {
  await connect(page);
  await setCard(page, 'iso4-desfire');
  await page.getByTestId('btn-scan').click();

  await page.getByTestId('input-apdu').fill('60');
  await page.getByTestId('btn-apdu-send').click();

  const resp = page.getByTestId('apdu-response');
  await expect(resp).toContainText('04010133001605', { timeout: 3000 });
  await expect(resp).toContainText('9100');
});

test('ISO4 CLONE_READ returns ERR CLONE_UNSUPPORTED', async ({ page }) => {
  await connect(page);
  await setCard(page, 'iso4-desfire');
  await page.getByTestId('btn-scan').click();
  // The clone panel is hidden for ISO4, so drive CLONE_READ via raw command.
  await page.getByTestId('input-raw').fill('CLONE_READ');
  await page.getByTestId('btn-send-raw').click();
  await expect(page.getByTestId('log')).toContainText('ERR CLONE_UNSUPPORTED TYPE=ISO_14443_4', { timeout: 3000 });
});

// ── JSON export/import round-trip ─────────────────────────────────────────────

test('Clone image JSON export/import round-trips the captured image', async ({ page }) => {
  await connect(page);
  await setCard(page, 'classic-locked');
  await page.getByTestId('btn-scan').click();
  await readSource(page);

  // Export populates the import box with JSON.
  await page.getByTestId('btn-clone-export').click();
  const exported = await page.getByTestId('input-clone-import').inputValue();
  expect(exported.length).toBeGreaterThan(20);
  const parsed = JSON.parse(exported);
  expect(parsed.uid).toBe('DEADBEEF');
  expect(Array.isArray(parsed.sectors)).toBe(true);

  // Clear the panel by importing the same JSON; image panel re-renders identically.
  await page.getByTestId('btn-clone-import').click();
  const panel = page.getByTestId('clone-image-panel');
  await expect(panel).toContainText('SECTOR 5 KEY=------------ KEYTYPE=NONE STATUS=FAILED', { timeout: 3000 });
  await expect(panel).toContainText('Image: UID=DEADBEEF');
});
