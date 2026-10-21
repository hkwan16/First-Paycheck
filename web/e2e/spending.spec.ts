import { expect, test, type Page } from '@playwright/test';
import { e2eApiUrl, linkSandboxBank, NO_E2E_API, openLink } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';

/*
 * The Spending screen against the real API, after link.spec.ts (this file's
 * project depends on it) has linked Plaid's sandbox bank for the e2e user.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

async function openSpending(page: Page) {
  await page.goto('/setup/spending');
  await waitForHydration(page);
  const table = page.getByRole('table', { name: 'Transactions' });
  await expect(table).toBeVisible({ timeout: 30_000 });
  return table;
}

test('starts from a linked sandbox bank', async ({ page }) => {
  // Normally link.spec.ts has linked it; run on its own, this file links it.
  await openLink(page);
  if ((await page.getByRole('group', { name: 'Plaid Checking' }).count()) === 0) {
    await linkSandboxBank(page);
  }
  await expect(page.getByRole('group', { name: 'Plaid Checking' })).toBeVisible();
});

test('lists the synced transactions with who labeled each one', async ({ page }) => {
  const table = await openSpending(page);
  const rows = table.getByRole('row');
  expect(await rows.count()).toBeGreaterThan(2);
  await expect(table.getByText(/^(Rule|You|AI( · \d+%)?|Not labeled)$/).first()).toBeVisible();
  // The summary waits for GET /spending/summary: skeletons, never client sums.
  const summary = page.getByRole('region', { name: /Your month so far/ });
  await expect(summary).toHaveAttribute('aria-busy', 'true');
  await expect(summary).not.toContainText('$');
});

test('a category fix is saved as a rule and survives a reload', async ({ page }) => {
  const table = await openSpending(page);
  const select = table.getByRole('combobox').first();
  const name = (await select.getAttribute('aria-label')) ?? '';
  const target = (await select.inputValue()) === 'entertainment' ? 'Dining' : 'Entertainment';
  const value = target.toLowerCase();

  await select.selectOption(target);
  await expect(select).toHaveValue(value);
  await expect(page.getByText(/^Saved as a rule\./)).toBeVisible({ timeout: 15_000 });

  const reloaded = await openSpending(page);
  const again = reloaded.getByRole('combobox', { name, exact: true }).first();
  await expect(again).toHaveValue(value);
});
