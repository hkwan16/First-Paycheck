import { expect, test, type Page } from '@playwright/test';
import { e2eApiUrl, linkSandboxBank, NO_E2E_API, openLink } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';
import {
  loadedSummary,
  monthOf,
  showPeriodWithTransactions,
  summaryMonth,
  transactionsIn,
} from './support/spending';

/*
 * The Spending screen against the real API, after link.spec.ts (this file's
 * project depends on it) has linked Plaid's sandbox bank for the e2e user.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

/** Spending on the period it opens on, or the newest one with transactions. */
async function openSpending(page: Page) {
  await page.goto('/setup/spending');
  await waitForHydration(page);
  return showPeriodWithTransactions(page);
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
  // The scale comes from gross pay, or from the income deposited when no pay
  // stub is confirmed (layoutCashFlow). This project depends on Link only, so
  // whether a stub is confirmed depends on what else ran; and the sandbox
  // bank may deposit nothing in the period. With neither, every amount is
  // still drawn, but there is nothing to scale bands by, so no badge.
  const scale = card.getByText(/^Scale: 1 px is about \$[\d,]+$/);
  const pay = card.getByRole('button', {
    name: /^(Gross pay, \d+ stubs?|Income deposited) \$(?!0\.00$)/,
  });
  if ((await pay.count()) > 0) await expect(scale).toBeVisible();
  else await expect(scale).toHaveCount(0);
  // Spec 007 rule 26a and spec 010 rule 5a (issue 164): income is deposits, and
  // the pay stubs are counted for this period only, whatever other months hold.
  await expect(summary.getByText('Deposits labeled income', { exact: true })).toBeVisible();
  await expect(summary).not.toContainText('paycheck');
  await expect(
    card.getByRole('button', { name: /^(Gross pay, \d+ stubs?|No pay stub this period) \$/ }),
  ).toHaveCount(1);
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

test('the transactions follow the period the summary shows', async ({ page }) => {
  await page.goto('/setup/spending');
  await waitForHydration(page);
  const listed = [await transactionsIn(page, await summaryMonth(await loadedSummary(page)))];
  const picker = page.getByRole('combobox', { name: 'Period' });
  for (const label of await picker.locator('option').allTextContents()) {
    await picker.selectOption({ label });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `Where ${monthOf(label)}'s money went`,
    );
    listed.push(await transactionsIn(page, monthOf(label)));
  }
  // The sandbox's rows are in some month the picker offers, so some period lists rows.
  expect(listed).toContain(true);
});

test('choosing another period reloads the totals and the diagram together', async ({ page }) => {
  await openSpending(page);
  const before = await loadedSummary(page);
  const heading = await before.getByRole('heading', { level: 2 }).textContent();
  const picker = page.getByRole('combobox', { name: 'Period' });
  // Any month but the one on screen.
  const month = await summaryMonth(before);
  const labels = await picker.locator('option').allTextContents();
  const label = labels.find((l) => monthOf(l) !== month) ?? '';
  await picker.selectOption({ label });
  const after = await loadedSummary(page);
  await expect(after.getByRole('heading', { level: 2 })).not.toHaveText(heading ?? '');
  await expect(flowCard(page)).not.toHaveAttribute('aria-busy', 'true');
  // No card failed. Scoped to the page's content: Next's route announcer is an
  // empty role="alert" it appends to <body> on every page.
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
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
