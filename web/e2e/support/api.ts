import { expect, type Page } from '@playwright/test';
import { waitForHydration } from './auth';

/*
 * The screens that read the API run end to end only against a real API: MSW
 * is for unit tests, and an e2e run that mocked the API would prove nothing
 * about the contract. Set E2E_API_URL to a running First Paycheck API (with
 * Plaid sandbox credentials and a worker) that accepts the e2e user's token;
 * playwright.config.ts points the web server's NEXT_PUBLIC_API_URL at it.
 */

export const NO_E2E_API =
  'Skipped: set E2E_API_URL to a running First Paycheck API (non-production, with Plaid sandbox credentials and a worker) to run the Link and Spending e2e tests against real data.';

export function e2eApiUrl(): string | null {
  return process.env.E2E_API_URL?.trim() || null;
}

/** The first setup step, hydrated and done loading accounts. */
export async function openLink(page: Page) {
  await page.goto('/setup/link');
  await waitForHydration(page);
  await expect(page.getByRole('region', { name: 'Bank accounts' })).not.toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(page.getByText('Loading your accounts')).toHaveCount(0);
}

/** Unlink every institution through the UI, so a run starts from a new user's state. */
export async function unlinkAll(page: Page) {
  const unlinkButtons = page.getByRole('button', { name: /^Unlink / });
  while ((await unlinkButtons.count()) > 0) {
    const label = (await unlinkButtons.first().getAttribute('aria-label')) ?? '';
    const name = label.replace(/^Unlink /, '');
    await unlinkButtons.first().click();
    await page.getByRole('button', { name: `Yes, unlink ${name}` }).click();
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });
  }
}

/** Link Plaid's sandbox bank with the e2e-only button and wait for its accounts. */
export async function linkSandboxBank(page: Page) {
  await page.getByRole('button', { name: 'Link sandbox bank (test)' }).click();
  await expect(page.getByRole('progressbar', { name: /^Syncing / })).toBeVisible();
  await expect(page.getByText(/^Linked .+\./)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('group', { name: 'Plaid Checking' })).toBeVisible();
}
