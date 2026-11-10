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

test('lists the synced transactions with where each category came from', async ({ page }) => {
  const table = await openSpending(page);
  const rows = table.getByRole('row');
  expect(await rows.count()).toBeGreaterThan(2);
  await expect(
    table.getByText(/^(Known merchant|You|Our guess|Guess, check it|No category)$/).first(),
  ).toBeVisible();
});

test('lists only the accounts the totals cover, and no loan interest as a bill (issue 200)', async ({
  page,
}) => {
  const table = await openSpending(page);
  const summary = await loadedSummary(page);
  // "First Platypus Bank ··1000 and ··2000": the accounts the totals read.
  const covered = new Set(((await summary.getByText(/··\d+/).textContent()) ?? '').match(/··\d+/g));
  expect(covered.size).toBeGreaterThan(0);
  const toggle = page.getByRole('button', { name: 'Show all transactions' });
  if ((await toggle.count()) > 0) await toggle.click();
  const masks = await table
    .getByRole('rowgroup')
    .nth(1)
    .getByText(/^··\d+$/)
    .allTextContents();
  expect(masks.length).toBeGreaterThan(0);
  // A loan's "Monthly payment" and "Interest charged" rows used to sit here,
  // on the loans' own masks, under totals that left them out.
  for (const mask of masks) expect(covered).toContain(mask);
  const recurring = page.getByRole('region', { name: 'Recurring charges' });
  await expect(recurring).not.toHaveAttribute('aria-busy', 'true');
  await expect(recurring.getByRole('listitem', { name: /^Interest/ })).toHaveCount(0);
});

test('the summary, the diagram and the recurring charges come before the list (issue 201)', async ({
  page,
}) => {
  const table = await openSpending(page);
  // The list opens on its newest 10 rows.
  expect(await table.getByRole('rowgroup').nth(1).getByRole('row').count()).toBeLessThanOrEqual(10);
  const recurring = page.getByRole('region', { name: 'Recurring charges' });
  const box = await recurring.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport).toBeTruthy();
  // Eight screens before: a 1,129 px diagram and fifty rows. Now the three
  // cards that sum up the month end within three screens.
  expect(box!.y + box!.height).toBeLessThan(3 * viewport!.height);
});

const flowCard = (page: Page) =>
  page.getByRole('region', { name: /^Where each dollar of (\w+ )?pay went$/ });

/** "$1,996.04" to 199604: reading a figure off the page to compare, not money math. */
const centsOf = (text: string) => Number(text.replace(/[$,.]/g, ''));

/** The diagram's node buttons (the Sankey; the stacked bars have none). */
const flowNodes = (page: Page) => flowCard(page).locator('[data-flow-host] > button');

/** The diagram's nodes as drawn: each one's name, the API's amount and its height. */
async function drawnNodes(page: Page) {
  const drawn = [];
  for (const node of await flowNodes(page).all()) {
    const label = ((await node.textContent()) ?? '').trim();
    const amount = /\$([\d,]+\.\d{2})$/.exec(label)?.[0] ?? '$0.00';
    const box = await node.boundingBox();
    drawn.push({
      name: label.replace(/ \$[\d,]+\.\d{2}$/, ''),
      cents: centsOf(amount),
      height: box?.height ?? 0,
    });
  }
  return drawn;
}

test('the cash flow and the summary tiles show the same totals from the API', async ({ page }) => {
  await openSpending(page);
  const summary = await loadedSummary(page);
  const card = flowCard(page);
  await expect(card).not.toHaveAttribute('aria-busy', 'true');
  if ((await card.getByText(/^Nothing to draw for /).count()) > 0) {
    test.info().annotations.push({ type: 'note', description: 'No money in the default period' });
    return;
  }
  // The scale comes from the largest node (spec 010 rule 5c): whatever the
  // period holds, a stub, deposits or only spending, any amount gives one.
  const scale = card.getByText(/^Scale: 1 px is about \$[\d,.]+$/);
  const amounts = card.getByRole('button', { name: /\$(?!0\.00$)[\d,]+\.\d{2}$/ });
  if ((await amounts.count()) > 0) await expect(scale).toBeVisible();
  else await expect(scale).toHaveCount(0);
  // Spec 007 rule 26a and spec 010 rule 5a (issue 164): income is deposits, and
  // the pay stubs are counted for this period only, whatever other months hold.
  await expect(summary.getByText('Income deposited', { exact: true })).toBeVisible();
  await expect(
    summary.getByText('Pay and other income into your accounts', { exact: true }),
  ).toBeVisible();
  // Issue 200: the card says which half comes from the stubs and which from the deposits.
  await expect(card).toContainText(/Spending comes from the \$[\d,]+\.\d{2}/);
  await expect(summary).not.toContainText('paycheck');
  await expect(
    card.getByRole('button', { name: /^(Gross pay, \d+ stubs?|No pay stub this period) \$/ }),
  ).toHaveCount(1);
  // Both routes compute the period with the same code (spec 010 rule 5):
  // every bucket the diagram draws matches its tile. A bucket with refunds is
  // drawn before them (rule 5b) and its details give the tile's amount.
  for (const bucket of ['Essentials', 'Flexible', 'Savings']) {
    // Anchored on the amount: "Savings transfer" is a category under Savings.
    const node = card.getByRole('button', { name: new RegExp(`^${bucket} \\$`) });
    let amount = ((await node.textContent()) ?? '').replace(bucket, '').trim();
    await node.focus();
    const details = card.getByRole('group', { name: bucket });
    await expect(details).toBeVisible();
    const after = /The summary counts (\$[\d,]+\.\d{2}) after/.exec(
      (await details.textContent()) ?? '',
    );
    if (after?.[1]) amount = after[1];
    await page.keyboard.press('Escape');
    expect(amount).toMatch(/^\$[\d,]+\.\d{2}$/);
    await expect(summary).toContainText(amount);
  }
});

test('every node is as tall as its own amount, and the legend lists only what is drawn (issue 236)', async ({
  page,
}) => {
  await openSpending(page);
  await loadedSummary(page);
  const card = flowCard(page);
  await expect(card).not.toHaveAttribute('aria-busy', 'true');
  test.skip((await flowNodes(page).count()) === 0, 'No money to draw');
  const nodes = await drawnNodes(page);
  // One scale for every node: a node taller than the words need is its
  // amount in pixels, so height over amount is the same for all of them.
  // (Take-home was drawn as tall as the spending linked to it, taller than gross.)
  const scaled = nodes.filter((n) => n.cents > 0 && n.height > 40);
  const ratios = scaled.map((n) => n.height / n.cents);
  const top = Math.max(...ratios);
  for (const [i, ratio] of ratios.entries()) {
    expect(Math.abs(ratio - top) * scaled[i]!.cents, scaled[i]!.name).toBeLessThan(2);
  }
  const gross = nodes.find((n) => n.name.startsWith('Gross pay'));
  const takeHome = nodes.find((n) => n.name === 'Take-home');
  if (gross && takeHome) expect(takeHome.height).toBeLessThanOrEqual(gross.height + 0.5);

  const legend = card.getByRole('list', { name: 'Legend' });
  const items = await legend.getByRole('listitem').allTextContents();
  expect(items.length).toBeGreaterThan(0);
  if (nodes.some((n) => n.name === 'No pay stub this period')) {
    for (const item of items) expect(item).not.toMatch(/Gross pay|Taxes|Health premiums|401\(k\)/);
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

test('the transactions follow the period the summary shows, and every month offered has something to show', async ({
  page,
}) => {
  await page.goto('/setup/spending');
  await waitForHydration(page);
  const opened = await summaryMonth(await loadedSummary(page));
  const listed = [await transactionsIn(page, opened)];
  const picker = page.getByRole('combobox', { name: 'Period' });
  await expect(picker).toBeEnabled();
  for (const label of await picker.locator('option').allTextContents()) {
    await picker.selectOption({ label });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `Where ${monthOf(label)}'s money went`,
    );
    const rows = await transactionsIn(page, monthOf(label));
    listed.push(rows);
    // Issue 236: June 2026 was offered with no transaction and no pay stub.
    // Only the month it opened on is offered whatever it holds (spec 010 rule 5d).
    if (monthOf(label) !== opened) {
      const heading = await (
        await loadedSummary(page)
      )
        .getByRole('heading', { level: 2 })
        .textContent();
      expect(rows || !/no pay stub$/.test(heading ?? ''), label).toBe(true);
    }
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

test('a category fix holds for the merchant and survives a reload', async ({ page }) => {
  const table = await openSpending(page);
  const select = table.getByRole('combobox').first();
  const name = (await select.getAttribute('aria-label')) ?? '';
  const target = (await select.inputValue()) === 'entertainment' ? 'Dining' : 'Entertainment';
  const value = target.toLowerCase();

  await select.selectOption(target);
  await expect(select).toHaveValue(value);
  await expect(page.getByText(/^Saved\./)).toBeVisible({ timeout: 15_000 });

  const reloaded = await openSpending(page);
  const again = reloaded.getByRole('combobox', { name, exact: true }).first();
  await expect(again).toHaveValue(value);
});
