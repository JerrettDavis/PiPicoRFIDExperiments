import { expect, type Page } from '@playwright/test';

export const URL = 'http://localhost:4188/PiPicoRFIDExperiments/?mock=1';

export type TabId = 'read' | 'edit' | 'clone' | 'identify' | 'console';

export interface GotoOpts {
  /** When true, do NOT click connect (leave disconnected). */
  noConnect?: boolean;
}

/** Navigate to the app and (by default) connect. */
export async function gotoConnected(page: Page, opts: GotoOpts = {}): Promise<void> {
  await page.goto(URL);
  if (!opts.noConnect) {
    await page.getByTestId('btn-connect').click();
    await expect(page.getByTestId('status-text')).toHaveText('Connected');
  }
}

/** Switch to a tab and assert its panel is visible. */
export async function openTab(page: Page, id: TabId): Promise<void> {
  await page.getByTestId(`tab-${id}`).click();
  await expect(page.getByTestId(`panel-${id}`)).toBeVisible();
}

/** Select a mock card kind (mock transport only). */
export async function setCard(page: Page, kind: string): Promise<void> {
  await page.evaluate((k) => window.__mockSetCard!(k as never), kind);
}
