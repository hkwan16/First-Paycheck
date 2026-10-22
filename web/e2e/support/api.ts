import { expect, test, type Page } from '@playwright/test';
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

export const NO_PLAID_SANDBOX =
  'Skipped: the API has no Plaid sandbox keys (E2E_PLAID_SANDBOX=0). Set PLAID_CLIENT_ID and PLAID_SECRET for scripts/e2e_stack.py to link a bank.';

/**
 * Whether the API can link Plaid's sandbox bank. The local stack
 * (scripts/e2e_stack.py) sets E2E_PLAID_SANDBOX to 1 or 0; a hosted API is
 * assumed to have its keys.
 */
export function plaidSandboxAvailable(): boolean {
  return process.env.E2E_PLAID_SANDBOX?.trim() !== '0';
}

/**
 * The first setup step, hydrated and done loading accounts. The first read of
 * a deployed API can take a while (a service waking up takes up to a minute), so
 * the loading state gets far more than the 5 s default.
 */
export async function openLink(page: Page) {
  await page.goto('/setup/link');
  await waitForHydration(page);
  await expect(page.getByRole('region', { name: 'Bank accounts' })).not.toHaveAttribute(
    'aria-busy',
    'true',
    { timeout: 60_000 },
  );
  await expect(page.getByText('Loading your accounts')).toHaveCount(0, { timeout: 60_000 });
}

/**
 * Unlink every institution through the UI, so a run starts from a new user's
 * state. A linked bank says Unlink; an imported CSV account says Remove.
 */
export async function unlinkAll(page: Page) {
  const card = page.getByRole('region', { name: 'Bank accounts' });
  const unlinkButtons = card.getByRole('button', { name: /^(Unlink|Remove) / });
  while ((await unlinkButtons.count()) > 0) {
    const label = (await unlinkButtons.first().getAttribute('aria-label')) ?? '';
    const [verb = '', ...rest] = label.split(' ');
    const name = rest.join(' ');
    await unlinkButtons.first().click();
    await card.getByRole('button', { name: `Yes, ${verb.toLowerCase()} ${name}` }).click();
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });
  }
}

/*
 * When Plaid has not pulled a new sandbox item's transactions yet, the API's
 * sync job waits 120 s before trying again (NOT_READY_RETRY_SECONDS in
 * api/sync/plaid/provider.py), and the screen shows the queued job meanwhile.
 * A link may take two such waits before its first sync runs.
 */
const SYNC_BUDGET_MS = 300_000;

/** Link Plaid's sandbox bank with the e2e-only button and wait for its accounts. */
export async function linkSandboxBank(page: Page) {
  test.info().setTimeout(test.info().timeout + SYNC_BUDGET_MS);
  await page.getByRole('button', { name: 'Link sandbox bank (test)' }).click();
  // Plaid's sandbox takes seconds to make and exchange the token before the
  // sync starts, and a short sync can finish between two looks at the bar, so
  // the sync shows either as its progress bar or as already done.
  const done = page.getByText(/^Linked .+\./);
  await expect(page.getByRole('progressbar', { name: /^Syncing / }).or(done)).toBeVisible({
    timeout: 60_000,
  });
  await expect(done).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(page.getByRole('group', { name: 'Plaid Checking' })).toBeVisible();
}
