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
});

/** The summary card, once GET /cashflow has answered (its heading names the period). */
async function loadedSummary(page: Page) {
  const summary = page.getByRole('region', { name: /^\w+ \d+.* to .+ · \d+ paychecks?$/ });
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await expect(summary).not.toHaveAttribute('aria-busy', 'true');
  return summary;
}

const flowCard = (page: Page) =>
  page.getByRole('region', { name: /^Where each dollar of (\w+ )?pay went$/ });

test('the cash flow and the summary tiles show the same totals from the API', async ({ page }) => {
  await openSpending(page);
  const summary = await loadedSummary(page);
  const card = flowCard(page);
  await expect(card).not.toHaveAttribute('aria-busy', 'true');
  if ((await card.getByText(/^Nothing to draw for /).count()) > 0) {
    test.info().annotations.push({ type: 'note', description: 'No money in the default period' });
    return;
  }
  await expect(card.getByText(/^Scale: 1 px is about \$[\d,]+$/)).toBeVisible();
  // Both routes compute the period with the same code (spec 010 rule 5):
  // every bucket the diagram draws matches its tile.
  for (const bucket of ['Essentials', 'Flexible', 'Savings']) {
    // Anchored on the amount: "Savings transfer" is a category under Savings.
    const node = card.getByRole('button', { name: new RegExp(`^${bucket} \\$`) });
    const amount = ((await node.textContent()) ?? '').replace(bucket, '').trim();
    expect(amount).toMatch(/^\$[\d,]+\.\d{2}$/);
    await expect(summary).toContainText(amount);
  }
});

test('a node opens its details from the keyboard and Escape returns focus', async ({ page }) => {
  await openSpending(page);
  await loadedSummary(page);
  const card = flowCard(page);
  const first = card.getByRole('button').first();
  test.skip((await first.count()) === 0, 'No money in the default period to draw');
  await first.focus();
  await expect(card.getByRole('group')).toHaveCount(1);
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(card.getByRole('group')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(card.getByRole('group')).toHaveCount(0);
  await expect(card.locator(':focus')).toHaveAttribute('aria-expanded', 'false');
});

test('choosing another period reloads the totals and the diagram together', async ({ page }) => {
  await openSpending(page);
  const before = await loadedSummary(page);
  const heading = await before.getByRole('heading', { level: 2 }).textContent();
  const picker = page.getByRole('combobox', { name: 'Period' });
  // The first option is the current month so far; the default is the last complete one.
  const label = (await picker.locator('option').first().textContent()) ?? '';
  await picker.selectOption({ label });
  const after = await loadedSummary(page);
  await expect(after.getByRole('heading', { level: 2 })).not.toHaveText(heading ?? '');
  await expect(flowCard(page)).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('alert')).toHaveCount(0);
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
