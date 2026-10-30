import { expect, type Locator, type Page } from '@playwright/test';

/*
 * The Spending screen's period, as the real-API specs read it. The
 * Transactions card lists the period the summary shows (spec 003 rule 17a),
 * so a spec that needs rows picks a month that has some.
 */

/** The summary card, once GET /cashflow has answered (its heading names the period). */
export async function loadedSummary(page: Page) {
  const summary = page.getByRole('region', {
    name: /^\w+ \d+.* to .+ · (\d+ pay stubs?|no pay stub)$/,
  });
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await expect(summary).not.toHaveAttribute('aria-busy', 'true');
  return summary;
}

/** The month a period's text starts with: "October" for "October 2026 so far". */
export const monthOf = (text: string) => text.split(' ')[0] ?? '';

/** The month the summary shows: "September" for "September 1 to 30 · 2 pay stubs". */
export const summaryMonth = async (summary: Locator) =>
  monthOf((await summary.getByRole('heading', { level: 2 }).textContent()) ?? '');

/**
 * Waits until the Transactions card shows `month`: rows all dated in that
 * month, or the sentence saying it has none. Returns whether it listed rows.
 * Checked as a whole until it holds, because the last period's rows stay on
 * screen while the next period loads.
 */
export async function transactionsIn(page: Page, month: string): Promise<boolean> {
  const card = page.getByRole('region', { name: 'Transactions' });
  const table = card.getByRole('table', { name: 'Transactions' });
  const empty = card.getByText(new RegExp(`^No transactions from ${month} `));
  // "Sep 30": the table's short dates start with the month's first three letters.
  const inMonth = new RegExp(`^${month.slice(0, 3)} \\d+`);
  let rows = false;
  await expect(async () => {
    expect(await card.getAttribute('aria-busy')).toBeNull();
    if (await empty.isVisible()) {
      rows = false;
      return;
    }
    const dates = await table
      .getByRole('rowgroup')
      .nth(1)
      .getByRole('row')
      .locator('[role="cell"]:first-child')
      .allTextContents();
    expect(dates.length).toBeGreaterThan(0);
    for (const date of dates) expect(date).toMatch(inMonth);
    rows = true;
  }).toPass({ timeout: 30_000 });
  return rows;
}

/**
 * On the Spending screen, stays on the period it opened on or, when that
 * month has no transactions, picks the newest month in the picker that has
 * some (the sandbox bank's history may all be in the month so far). Returns
 * the Transactions table.
 */
export async function showPeriodWithTransactions(page: Page) {
  const table = page.getByRole('table', { name: 'Transactions' });
  if (await transactionsIn(page, await summaryMonth(await loadedSummary(page)))) return table;
  const picker = page.getByRole('combobox', { name: 'Period' });
  for (const label of await picker.locator('option').allTextContents()) {
    await picker.selectOption({ label });
    if (await transactionsIn(page, monthOf(label))) return table;
  }
  throw new Error('No period in the picker has transactions');
}
