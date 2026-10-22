import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { waitForHydration } from './auth';

/** Where the capture specs write their PNGs; they skip without it. */
export const CAPTURE_DIR = process.env.E2E_CAPTURE_DIR?.trim() || null;

export const NO_CAPTURE_DIR =
  'Skipped: set E2E_CAPTURE_DIR to the folder the screenshots go in (docs/alpha/screenshots).';

export const PHONE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 820 };

/** Save a full-page screenshot of the page, or one of a single element. */
export async function shot(target: Page | Locator, name: string) {
  if (!CAPTURE_DIR) throw new Error(NO_CAPTURE_DIR);
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const file = path.join(CAPTURE_DIR, `${name}.png`);
  if ('goto' in target) await target.screenshot({ path: file, fullPage: true });
  else await target.screenshot({ path: file });
}

/** Hydrated, no request in flight, and no region still marked busy. */
export async function settled(page: Page) {
  await waitForHydration(page);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
}
