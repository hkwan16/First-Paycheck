import { delay, http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beyondCashflow,
  dynamicCashflow,
  emptyCashflow,
  noIncomeCashflow,
  sandboxCashflow,
} from '@/test/fixtures/cashflow';
import { SAMPLE_NOW, sampleCsvAccount, sampleTransactions } from '@/test/fixtures/sample';
import { db, emptyDb } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { spendingDb } from '@/test/msw/spending-handlers';
import type { Transaction } from '@/lib/api/types';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { SpendingScreen } from './SpendingScreen';

// A row's accessible name is all of its text, its category select's options included, which
// jsdom works out node by node; find a row's select by its own label instead.
const row = (merchant: string, index = 0) =>
  screen.getAllByRole('row', { name: new RegExp(merchant) })[index]!;
const categoryOf = (merchant: string, index = 0) =>
  screen.getAllByRole('combobox', { name: `Category for ${merchant}` })[index]!;

async function renderSpending(props: Parameters<typeof SpendingScreen>[0] = {}) {
  const rendered = renderWithProviders(<SpendingScreen {...props} />, {
    advanceTimers: vi.isFakeTimers() ? vi.advanceTimersByTime : undefined,
  });
  await screen.findAllByRole('combobox', { name: 'Category for Sweetgreen' });
  return rendered;
}

afterEach(() => server.events.removeAllListeners());

/**
 * Picks a period once the picker offers it: its months wait for
 * `GET /spending/months` (spec 010 rule 5d), which can answer after the rows.
 */
async function pickPeriod(user: Awaited<ReturnType<typeof renderSpending>>['user'], label: string) {
  const picker = await screen.findByRole('combobox', { name: 'Period' });
  await within(picker).findByRole('option', { name: label });
  await user.selectOptions(picker, label);
}

/** Opens the Transactions card's whole list (it shows the newest 10 rows first). */
async function showAll(user: Awaited<ReturnType<typeof renderSpending>>['user']) {
  await user.click(screen.getByRole('button', { name: 'Show all transactions' }));
}

const summaryRegion = () => screen.getByRole('region', { name: /pay stubs?$|Your month so far/ });
const tile = (label: string) => within(summaryRegion()).getByText(label).parentElement!;
const LOAN_ID = '1a2b3c4d-0000-4000-8000-00000000a070';

/** Query strings of every `GET /cashflow`. */
function cashflowReads() {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === '/cashflow') seen.push(url.search);
  });
  return seen;
}

describe('SpendingScreen summary', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
  afterEach(() => vi.useRealTimers());

  it('shows the four bucket tiles from GET /cashflow, exactly as the API totals them', async () => {
    await renderSpending();
    await waitFor(() => expect(summaryRegion()).not.toHaveAttribute('aria-busy'));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      "Where October's money went",
    );
    expect(summaryRegion()).toHaveAccessibleName('October 1 to 17 · 2 pay stubs');
    expect(tile('Income deposited')).toHaveTextContent('$3,992.08');
    expect(tile('Income deposited')).toHaveTextContent('Pay and other income into your accounts');
    expect(tile('Essentials')).toHaveTextContent('$1,823.25');
    expect(tile('Essentials')).toHaveTextContent('46% of income');
    expect(tile('Flexible')).toHaveTextContent('$249.89');
    expect(tile('Flexible')).toHaveTextContent('6% of income');
    expect(tile('Savings')).toHaveTextContent('$300.00');
    expect(tile('Savings')).toHaveTextContent('Savings rate 8%');
    expect(summaryRegion()).toHaveTextContent('Left over: $1,618.94, still in your accounts.');
  });

  it('shows skeletons, never client sums, until the totals arrive', async () => {
    server.use(
      http.get(apiUrl('/cashflow'), async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    renderWithProviders(<SpendingScreen />);
    const summary = await screen.findByRole('region', { name: /Your month so far/ });
    expect(summary).toHaveAttribute('aria-busy', 'true');
    expect(summary).not.toHaveTextContent('$');
    expect(summary.querySelectorAll('[data-skeleton]').length).toBeGreaterThanOrEqual(8);
    // The transactions wait for the period the API answers with (spec 003 rule 17a).
    const transactions = screen.getByRole('region', { name: 'Transactions' });
    expect(within(transactions).getByText('Loading your transactions')).toBeInTheDocument();
  });

  it('names the linked accounts the summary covers', async () => {
    await renderSpending();
    expect(summaryRegion()).toHaveTextContent('Chase ··4821 and ··7730');
  });

  it('names an unnamed imported account as the Link screen does', async () => {
    // Issue 183: one helper names an institution, so Spending never says "Linked bank" for a CSV.
    db.accounts.push({ ...structuredClone(sampleCsvAccount), institution_name: null });
    await renderSpending();
    expect(summaryRegion()).toHaveTextContent('Imported CSV Credit union checking');
    expect(summaryRegion()).not.toHaveTextContent('Linked bank');
  });

  it('says when more went out than came in', async () => {
    spendingDb.cashflow.spending.left_over_cents = -12_345;
    await renderSpending();
    expect(await within(summaryRegion()).findByText(/You spent more/)).toHaveTextContent(
      'Left over: -$123.45. You spent more than came in.',
    );
  });

  it('says there is too little income to compare when there was none', async () => {
    spendingDb.cashflow = emptyCashflow('2026-10-01', '2026-10-17');
    await renderSpending();
    await waitFor(() => expect(tile('Essentials')).toHaveTextContent('$0.00'));
    expect(tile('Essentials')).toHaveTextContent('Too little income to compare');
    expect(tile('Savings')).toHaveTextContent('Too little income to compare');
  });

  it('says so for a share the API holds back as too large, and shows the rest', async () => {
    // Plaid's user_transactions_dynamic October (spec 007 rules 21a and 25):
    // 12 cents of income against $364.80 of essentials.
    spendingDb.cashflow = dynamicCashflow();
    await renderSpending();
    await waitFor(() => expect(tile('Income deposited')).toHaveTextContent('$0.12'));
    expect(tile('Essentials')).toHaveTextContent('$364.80');
    expect(tile('Essentials')).toHaveTextContent('Too little income to compare');
    expect(tile('Essentials')).not.toHaveTextContent('%');
    expect(tile('Flexible')).toHaveTextContent('-$1,019.79');
    expect(tile('Flexible')).toHaveTextContent('Too little income to compare');
    expect(tile('Savings')).toHaveTextContent('Savings rate 0%');
  });

  it('says how many loan, investment and retirement transactions the totals left out', async () => {
    spendingDb.cashflow = dynamicCashflow();
    await renderSpending();
    expect(
      await within(summaryRegion()).findByText(
        'Not counted: 165 transactions on loan, investment and retirement accounts. A loan payment counts once, when it leaves checking.',
      ),
    ).toBeInTheDocument();
  });

  it('says nothing about ledgers when none were left out', async () => {
    await renderSpending();
    await waitFor(() => expect(tile('Income deposited')).toHaveTextContent('$3,992.08'));
    expect(summaryRegion()).not.toHaveTextContent(/Not counted/);
  });

  it('offers a retry when the totals cannot be read', async () => {
    server.use(
      http.get(apiUrl('/cashflow'), () =>
        HttpResponse.json({ error: { code: 'x', message: 'Database is busy' } }, { status: 503 }),
      ),
    );
    const { user } = await renderSpending();
    const alert = await within(summaryRegion()).findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your totals. Database is busy');
    server.resetHandlers();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(tile('Income deposited')).toHaveTextContent('$3,992.08'));
  });

  it("picks a period: this month so far, the API's last complete month, or one before", async () => {
    const reads = cashflowReads();
    const { user } = await renderSpending();
    const picker = await screen.findByRole('combobox', { name: 'Period' });
    await waitFor(() => expect(picker).toHaveValue('2026-10'));
    await waitFor(() =>
      expect(
        within(picker)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual([
        'October 2026 so far',
        'September 2026',
        'August 2026',
        'July 2026',
        'June 2026',
        'May 2026',
      ]),
    );

    await user.selectOptions(picker, 'August 2026');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        "Where August's money went",
      ),
    );
    expect(picker).toHaveValue('2026-08');

    await user.selectOptions(picker, 'October 2026 so far');
    await waitFor(() => expect(reads).toContain('?start=2026-10-01&end=2026-10-17'));

    // The last complete month is the API's default: no dates are sent.
    await user.selectOptions(picker, 'September 2026');
    expect(reads).toEqual([
      '',
      '?start=2026-08-01&end=2026-08-31',
      '?start=2026-10-01&end=2026-10-17',
    ]);
  });

  it('offers only the months the API says have something to show (issue 236)', async () => {
    // June 2026 had no transaction and no pay stub, and the picker offered it anyway.
    spendingDb.months = ['2026-10-01', '2026-09-01', '2026-07-01'];
    await renderSpending();
    const picker = await screen.findByRole('combobox', { name: 'Period' });
    await waitFor(() =>
      expect(
        within(picker)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['October 2026 so far', 'September 2026', 'July 2026']),
    );
  });

  it('still offers the period it shows when the API lists no month', async () => {
    spendingDb.months = [];
    await renderSpending();
    const picker = await screen.findByRole('combobox', { name: 'Period' });
    await waitFor(() =>
      expect(
        within(picker)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['October 1 to 17']),
    );
  });

  it('offers every month when the months cannot be read', async () => {
    server.use(
      http.get(apiUrl('/spending/months'), () =>
        HttpResponse.json({ error: { code: 'x', message: 'Database is busy' } }, { status: 503 }),
      ),
    );
    await renderSpending();
    const picker = await screen.findByRole('combobox', { name: 'Period' });
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(6));
  });

  it('opens on a given period', async () => {
    const reads = cashflowReads();
    renderWithProviders(
      <SpendingScreen initialPeriod={{ start: '2026-10-01', end: '2026-10-17' }} />,
    );
    await waitFor(() => expect(reads).toEqual(['?start=2026-10-01&end=2026-10-17']));
  });

  it('has no cash flow diagram while the sankey flag is off', async () => {
    await renderSpending();
    expect(screen.queryByRole('heading', { name: /Where each dollar/ })).not.toBeInTheDocument();
  });
});

describe('SpendingScreen cash flow (sankey flag on)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
  afterEach(() => vi.useRealTimers());

  const card = () => screen.getByRole('region', { name: /Where each dollar/ });
  const node = (name: string) => within(card()).getByRole('button', { name });

  it('draws the period as a Sankey with the computed scale', async () => {
    await renderSpending({ showSankey: true });
    expect(
      await screen.findByRole('heading', { name: 'Where each dollar of October pay went' }),
    ).toBeInTheDocument();
    expect(within(card()).getByText('Scale: 1 px is about $23')).toBeInTheDocument();
    expect(node('Gross pay, 2 stubs $5,416.66')).toBeInTheDocument();
    expect(node('Take-home $3,992.08')).toBeInTheDocument();
    expect(within(card()).getByText('Pay stubs, October')).toBeInTheDocument();
  });

  it('says which half of the diagram comes from the pay stubs and which from the deposits (issue 200)', async () => {
    await renderSpending({ showSankey: true });
    await within(card()).findByRole('button', { name: 'Gross pay, 2 stubs $5,416.66' });
    expect(card()).toHaveTextContent(
      'Gross pay to take-home comes from 2 pay stubs. Spending comes from the $3,992.08 deposited in your accounts, which can include pay with no confirmed stub.',
    );
  });

  it("lists a category's transactions in its popover, with where each category came from", async () => {
    const { user } = await renderSpending({ showSankey: true });
    await user.hover(await within(card()).findByRole('button', { name: 'Shopping $204.90' }));
    const popover = within(card()).getByRole('group', { name: 'Shopping' });
    expect(popover).toHaveTextContent('2 transactions in this period');
    const lines = within(popover).getAllByRole('listitem');
    expect(lines.map((l) => l.textContent)).toEqual([
      'Costco WholesaleGuess, check it-$142.60Oct 13 · ··4821',
      'AmazonOur guess-$62.30Oct 9 · ··4821',
    ]);
  });

  it("leaves a loan ledger's rows out of a category's popover, as the API leaves them out of its total", async () => {
    db.accounts = [
      ...db.accounts,
      {
        ...sampleCsvAccount,
        id: LOAN_ID,
        provider: 'plaid',
        name: 'Auto loan',
        kind: 'loan',
      },
    ];
    db.transactions = [
      {
        ...sampleTransactions.find((t) => t.category === 'shopping')!,
        id: '7a000000-0000-4000-8000-00000000a001',
        account_id: LOAN_ID,
        merchant_raw: 'Loan ledger row',
        merchant_clean: 'Loan ledger row',
        posted_at: '2026-10-16',
      },
      ...db.transactions,
    ];
    const { user } = await renderSpending({ showSankey: true });
    await user.hover(await within(card()).findByRole('button', { name: 'Shopping $204.90' }));
    const popover = within(card()).getByRole('group', { name: 'Shopping' });
    expect(within(popover).getAllByRole('listitem')).toHaveLength(2);
    expect(popover).not.toHaveTextContent('Loan ledger row');
  });

  it('says so for a bucket whose share the API held back', async () => {
    spendingDb.cashflow = dynamicCashflow();
    const { user } = await renderSpending({ showSankey: true });
    await user.hover(await within(card()).findByRole('button', { name: 'Essentials $364.80' }));
    const popover = within(card()).getByRole('group', { name: 'Essentials' });
    expect(popover).toHaveTextContent('Too little income to compare');
    expect(popover).not.toHaveTextContent('Debt payments');
  });

  it('explains take-home from both sides: the pay stubs and the deposits', async () => {
    const { user } = await renderSpending({ showSankey: true });
    await user.hover(await within(card()).findByRole('button', { name: 'Take-home $3,992.08' }));
    const popover = within(card()).getByRole('group', { name: 'Take-home' });
    expect(popover).toHaveTextContent('Take-home on 2 pay stubs: $3,992.08');
    expect(popover).toHaveTextContent('Income deposited in your accounts: $3,992.08');
  });

  it("gives the buckets' shares of income as the API rounded them", async () => {
    const { user } = await renderSpending({ showSankey: true });
    await user.hover(await within(card()).findByRole('button', { name: 'Essentials $1,823.25' }));
    expect(within(card()).getByRole('group', { name: 'Essentials' })).toHaveTextContent(
      '45.7% of income',
    );
  });

  it('points from a $0 401(k) to the decision that sets it', async () => {
    const { user } = await renderSpending({ showSankey: true });
    await user.click(
      await within(card()).findByRole('button', { name: '401(k), not elected $0.00' }),
    );
    const popover = within(card()).getByRole('group', { name: '401(k), not elected' });
    expect(
      within(popover).getByRole('link', { name: 'See what a 401(k) match is worth' }),
    ).toHaveAttribute('href', '/setup/decisions/401k');
  });

  it('stacks bars instead under 640 px, with the same amounts and no scale', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(358);
    await renderSpending({ showSankey: true });
    width.mockRestore();
    await waitFor(() =>
      expect(within(card()).getByRole('region', { name: 'Take-home' })).toBeInTheDocument(),
    );
    expect(within(card()).queryByRole('img', { name: /Cash flow bands/ })).not.toBeInTheDocument();
    expect(within(card()).queryByText(/1 px is about/)).not.toBeInTheDocument();
    expect(within(card()).getByRole('region', { name: 'Gross pay, 2 stubs' })).toHaveTextContent(
      'Federal tax$595.52',
    );
  });

  it('draws spending with no pay stub or income, all of it from beyond the income', async () => {
    // What the e2e sandbox user's September looks like: a few charges, no deposits.
    spendingDb.cashflow = noIncomeCashflow();
    // The sample's rows are all in October, so September's table is empty.
    renderWithProviders(<SpendingScreen showSankey />);
    expect(await within(card()).findByRole('button', { name: 'Essentials $6.33' })).toBeVisible();
    // Spec 010 rule 5a: no stub in this period, which says nothing of other months'.
    expect(node('No pay stub this period $0.00')).toBeInTheDocument();
    expect(summaryRegion()).toHaveAccessibleName('September 1 to 30 · no pay stub');
    expect(tile('Income deposited')).toHaveTextContent('Pay and other income into your accounts');
    expect(card()).toHaveTextContent(
      'Spending comes from the $0.00 of income deposited in your accounts. Confirm a pay stub to see what comes out of your pay before payday.',
    );
    expect(summaryRegion()).not.toHaveTextContent(/paycheck/);
    expect(node('Income deposited $0.00')).toBeInTheDocument();
    expect(node('Flexible $500.00')).toBeInTheDocument();
    // A source beside the deposits, never a negative amount (spec 010 rule 5b).
    expect(node('Spent beyond income $506.33')).toBeInTheDocument();
    // The largest node sets the scale: 506.33 over 240 px is about $2 a pixel.
    expect(within(card()).getByText('Scale: 1 px is about $2')).toBeInTheDocument();
  });

  it('draws the sandbox month the API counts money in for, at a scale its tallest node sets', async () => {
    // The production walkthrough's month: GUSTO PAY is booked as money out,
    // so income is the 4.22 of interest that came in (spec 007 rule 22a).
    spendingDb.cashflow = sandboxCashflow();
    await renderSpending({ showSankey: true });
    expect(await within(card()).findByRole('button', { name: 'Savings $1,000.00' })).toBeVisible();
    expect(node('Income deposited $4.22')).toBeInTheDocument();
    expect(node('Refunds $500.00')).toBeInTheDocument();
    expect(node('Spent beyond income $1,685.41')).toBeInTheDocument();
    expect(tile('Income deposited')).toHaveTextContent('$4.22');
    // The largest node, spending beyond the income, is drawn 240 px tall:
    // $1,685.41 / 240 is $7.02, shown in whole dollars. (Scaled by the $4.22
    // of income, it read "$0.01".)
    expect(within(card()).getByText('Scale: 1 px is about $7')).toBeInTheDocument();
  });

  it('issue 236: draws take-home shorter than gross pay, and where the rest of the spending came from', async () => {
    // One stub: gross 2,708.33, take-home 1,996.04; 3,240.12 deposited and 5,234.98 spent.
    spendingDb.cashflow = beyondCashflow();
    const { user } = await renderSpending({ showSankey: true });
    const gross = await within(card()).findByRole('button', {
      name: 'Gross pay, 1 stub $2,708.33',
    });
    const takeHome = node('Take-home $1,996.04');
    expect(parseFloat(takeHome.style.height)).toBeLessThan(parseFloat(gross.style.height));
    expect(node('Other deposits $1,244.08')).toBeInTheDocument();
    expect(node('Spent beyond income $1,994.86')).toBeInTheDocument();
    expect(within(card()).queryByRole('button', { name: /^Left over/ })).not.toBeInTheDocument();

    await user.hover(node('Other deposits $1,244.08'));
    const other = within(card()).getByRole('group', { name: 'Other deposits' });
    expect(other).toHaveTextContent('Take-home on 1 pay stub: $1,996.04');
    expect(other).toHaveTextContent('Income deposited in your accounts: $3,240.12');
    await user.hover(node('Spent beyond income $1,994.86'));
    expect(within(card()).getByRole('group', { name: 'Spent beyond income' })).toHaveTextContent(
      'more than came in',
    );
  });

  it('says what a refund paid for and what the bucket is before it', async () => {
    spendingDb.cashflow = sandboxCashflow();
    const { user } = await renderSpending({ showSankey: true });
    await user.hover(await within(card()).findByRole('button', { name: 'Refunds $500.00' }));
    expect(within(card()).getByRole('group', { name: 'Refunds' })).toHaveTextContent(
      'Travel+$500.00',
    );
    await user.hover(node('Flexible $1,184.23'));
    expect(within(card()).getByRole('group', { name: 'Flexible' })).toHaveTextContent(
      'Spent before $500.00 of refunds. The summary counts $684.23 after them.',
    );
  });

  it('lists only what the period draws in the legend (issue 236)', async () => {
    spendingDb.cashflow = sandboxCashflow();
    await renderSpending({ showSankey: true });
    const legend = await within(card()).findByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Flexible spending',
      'Income deposited and refunds',
      'Essentials',
      'Savings',
      'Spent beyond income',
    ]);
    expect(legend).not.toHaveTextContent(/Gross pay|Taxes|Health premiums|Take-home/);
  });

  it('says there is nothing to draw for an empty period', async () => {
    spendingDb.cashflow = emptyCashflow('2026-10-01', '2026-10-17');
    await renderSpending({ showSankey: true });
    expect(
      await within(card()).findByText(
        'Nothing to draw for October 1 to 17 yet. Confirm a pay stub and link the account your pay lands in.',
      ),
    ).toBeInTheDocument();
    expect(within(card()).queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('SpendingScreen transactions', () => {
  it('lists the newest transactions first with date, merchant, account, source, category and amount', async () => {
    await renderSpending();
    const table = screen.getByRole('table', { name: 'Transactions' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(10);

    const [latest] = rows;
    expect(within(latest!).getByText('Oct 17')).toBeInTheDocument();
    expect(within(latest!).getByText("Trader Joe's")).toBeInTheDocument();
    expect(within(latest!).getByText('··4821')).toBeInTheDocument();
    expect(within(latest!).getByText('Known merchant')).toBeInTheDocument();
    expect(categoryOf("Trader Joe's")).toHaveValue('groceries');
    expect(within(latest!).getByText('-$91.33')).toBeInTheDocument();

    expect(within(row('Acme Corp Payroll')).getByText('+$1,996.04')).toHaveClass('text-plum-text');
    expect(within(row('Sweetgreen')).getByText('Our guess')).toHaveClass('bg-blue-tint');
    expect(within(row('Costco Wholesale')).getByText('Guess, check it')).toBeInTheDocument();
    expect(within(row('Blue Bottle Coffee')).getByText('You')).toBeInTheDocument();
  });

  it('opens on the newest 10 rows and shows every loaded row on request (issue 201)', async () => {
    const { user } = await renderSpending();
    const table = screen.getByRole('table', { name: 'Transactions' });
    const toggle = screen.getByRole('button', { name: 'Show all transactions' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', table.id);
    expect(screen.queryByRole('row', { name: /Parkline Apartments/ })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(16);
    expect(screen.getByRole('row', { name: /Parkline Apartments/ })).toBeInTheDocument();
    expect(toggle).toHaveAccessibleName('Show fewer');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveFocus();

    await user.click(toggle);
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(10);
  });

  it('offers no toggle when every row already shows', async () => {
    db.transactions = db.transactions.slice(0, 10);
    await renderSpending();
    expect(screen.queryByRole('button', { name: 'Show all transactions' })).not.toBeInTheDocument();
  });

  it('applies a fix at once, then confirms it was saved as a rule', async () => {
    // The server answers when the test says so, not after a timer a busy machine can outrun.
    const answer = Promise.withResolvers<void>();
    server.use(
      http.patch(apiUrl('/transactions/:id'), async ({ params, request }) => {
        await answer.promise;
        const { category } = (await request.json()) as { category: 'groceries' };
        const txn = db.transactions.find((t) => t.id === params.id)!;
        Object.assign(txn, { category, category_source: 'user', confidence: null });
        return HttpResponse.json({
          transaction: txn,
          rule: { merchant_norm: txn.merchant_norm, category },
          relabeled: 0,
        });
      }),
    );
    const { user } = await renderSpending();
    await user.selectOptions(categoryOf('Sweetgreen'), ['Groceries']);

    // Before the server answers: the new category and the person's badge.
    expect(categoryOf('Sweetgreen')).toHaveValue('groceries');
    expect(within(row('Sweetgreen')).getByText('You')).toBeInTheDocument();
    expect(screen.queryByText(/^Saved\./)).not.toBeInTheDocument();

    answer.resolve();
    expect(await screen.findByText(/^Saved\./)).toHaveTextContent(
      'Saved. Sweetgreen will be Groceries from now on.',
    );
  });

  it("relabels the merchant's other rows too and says how many", async () => {
    const { user } = await renderSpending();
    await showAll(user);
    await user.selectOptions(categoryOf("Trader Joe's", 0), ['Dining']);
    await waitFor(() => expect(categoryOf("Trader Joe's", 1)).toHaveValue('dining'));
    expect(within(row("Trader Joe's", 1)).getByText('Known merchant')).toBeInTheDocument();
    expect(await screen.findByText(/^Saved\./)).toHaveTextContent(
      "Saved. Trader Joe's will be Dining from now on, and 1 earlier transaction changed too.",
    );
  });

  it('puts the old category back and says so when the fix fails', async () => {
    server.use(
      http.patch(apiUrl('/transactions/:id'), () =>
        HttpResponse.json(
          { error: { code: 'validation_error', message: 'Category is not allowed' } },
          { status: 422 },
        ),
      ),
    );
    const { user } = await renderSpending();
    await user.selectOptions(categoryOf('Sweetgreen'), ['Travel']);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Could not save the category for Sweetgreen. It is back to Dining. Category is not allowed',
    );
    expect(categoryOf('Sweetgreen')).toHaveValue('dining');
    expect(within(row('Sweetgreen')).getByText('Our guess')).toBeInTheDocument();
    expect(screen.queryByText(/^Saved\./)).not.toBeInTheDocument();
  });

  it('shows the swatch of the category bucket next to each select', async () => {
    await renderSpending();
    const swatch = (merchant: string) =>
      within(row(merchant)).getByRole('combobox').parentElement!.querySelector('i');
    expect(swatch('Sweetgreen')).toHaveClass('bg-coral');
    expect(swatch('Verizon Wireless')).toHaveClass('bg-blue');
    expect(swatch('Acme Corp Payroll')).toHaveClass('bg-plum');
    expect(swatch('Transfer to Chase Savings')).toHaveClass('bg-teal');
  });

  it('loads more pages on request', async () => {
    db.transactions = Array.from({ length: 60 }, (_, i) => ({
      ...sampleTransactions[i % 16]!,
      id: `7c000000-0000-4000-8000-${String(1000 - i).padStart(12, '0')}`,
    }));
    const { user } = await renderSpending();
    const table = screen.getByRole('table', { name: 'Transactions' });
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(
      screen.queryByRole('button', { name: 'Load more transactions' }),
    ).not.toBeInTheDocument();
    await showAll(user);
    expect(within(table).getAllByRole('row')).toHaveLength(51);

    await user.click(screen.getByRole('button', { name: 'Load more transactions' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(61));
    expect(
      screen.queryByRole('button', { name: 'Load more transactions' }),
    ).not.toBeInTheDocument();
  });

  it('points to the first step when there is nothing to show', async () => {
    emptyDb();
    renderWithProviders(<SpendingScreen />);
    expect(await screen.findByText(/No transactions yet/)).toBeInTheDocument();
    expect(screen.queryByText(/No transactions from/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Link a bank' })).toHaveAttribute(
      'href',
      '/setup/link',
    );
  });

  it('offers a retry when transactions cannot be read', async () => {
    server.use(
      http.get(apiUrl('/transactions'), () =>
        HttpResponse.json({ error: { code: 'x', message: 'Database is busy' } }, { status: 503 }),
      ),
    );
    const { user } = renderWithProviders(<SpendingScreen />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your transactions. Database is busy');
    server.resetHandlers();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('row', { name: /Sweetgreen/ })).toBeInTheDocument();
  });

  it('continues to decisions', async () => {
    await renderSpending();
    expect(screen.getByRole('link', { name: /Use these numbers in decisions/ })).toHaveAttribute(
      'href',
      '/setup/decisions/emergency-fund',
    );
  });
});

describe('SpendingScreen transactions follow the period (spec 003 rule 17a)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
  afterEach(() => vi.useRealTimers());

  const AMAZON = sampleTransactions.find((t) => t.merchant_clean === 'Amazon')!;
  /** A shopping row on `postedAt`, named `merchant`. */
  const rowOn = (postedAt: string, merchant: string, n: number): Transaction => ({
    ...AMAZON,
    id: `7d000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    posted_at: postedAt,
    merchant_raw: merchant.toUpperCase(),
    merchant_clean: merchant,
    merchant_norm: merchant.toLowerCase(),
  });
  /** `count` August rows, "August shop 1" first. */
  const august = (count: number) =>
    Array.from({ length: count }, (_, i) => rowOn('2026-08-20', `August shop ${i + 1}`, i + 1));
  const AUGUST = {
    limit: '50',
    cash_accounts_only: 'true',
    start: '2026-08-01',
    end: '2026-08-31',
  };
  const OCTOBER = {
    limit: '50',
    cash_accounts_only: 'true',
    start: '2026-10-01',
    end: '2026-10-17',
  };

  /** The query of every `GET /transactions` page read (not the per-account counts). */
  function transactionReads() {
    const seen: Record<string, string>[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/transactions' && !url.searchParams.has('account_id')) {
        seen.push(Object.fromEntries(url.searchParams));
      }
    });
    return seen;
  }

  const card = () => screen.getByRole('region', { name: 'Transactions' });
  const listed = () =>
    within(within(card()).getByRole('table', { name: 'Transactions' }))
      .getAllByRole('row')
      .slice(1);

  it('lists only the period the summary shows, asking the API for its dates', async () => {
    db.transactions = [...db.transactions, rowOn('2026-09-20', 'Corner Bookshop', 1)];
    const reads = transactionReads();
    await renderSpending();
    // The API's default period is the one it answered for: October 1 to 17 here.
    expect(reads).toEqual([OCTOBER]);
    expect(listed()).toHaveLength(10);
    expect(screen.queryByRole('row', { name: /Corner Bookshop/ })).not.toBeInTheDocument();
  });

  it('follows the period picker, from the first page, and pages within the period', async () => {
    db.transactions = [...db.transactions, ...august(55)];
    const reads = transactionReads();
    const { user } = await renderSpending();

    await pickPeriod(user, 'August 2026');
    expect(await screen.findByRole('row', { name: /August shop 1\b/ })).toBeInTheDocument();
    expect(listed()).toHaveLength(10);
    await showAll(user);
    expect(listed()).toHaveLength(50);
    expect(screen.queryByRole('row', { name: /Sweetgreen/ })).not.toBeInTheDocument();
    expect(reads.at(-1)).toEqual(AUGUST);

    await user.click(screen.getByRole('button', { name: 'Load more transactions' }));
    await waitFor(() => expect(listed()).toHaveLength(55));
    expect(reads.at(-1)).toEqual({ ...AUGUST, cursor: expect.any(String) });
    expect(screen.queryByRole('row', { name: /Sweetgreen/ })).not.toBeInTheDocument();

    // Another period starts again from its own first page: October 1 to 17,
    // which the default read already asked for (the stand-in API answers the
    // default with those dates).
    await pickPeriod(user, 'October 2026 so far');
    await waitFor(() => expect(listed()).toHaveLength(16));
    expect(reads.filter((r) => r.start === '2026-10-01')).toEqual([OCTOBER]);
    expect(screen.queryByRole('row', { name: /August shop/ })).not.toBeInTheDocument();
  });

  it('keeps the last rows on screen while the next period loads', async () => {
    db.transactions = [...db.transactions, ...august(2)];
    const answer = Promise.withResolvers<void>();
    server.use(
      http.get(apiUrl('/transactions'), async ({ request }) => {
        if (new URL(request.url).searchParams.get('start') === AUGUST.start) await answer.promise;
      }),
    );
    const { user } = await renderSpending();
    await pickPeriod(user, 'August 2026');

    await waitFor(() => expect(card()).toHaveAttribute('aria-busy', 'true'));
    expect(listed()).toHaveLength(10);
    expect(within(card()).queryByText(/Loading your transactions/)).not.toBeInTheDocument();

    answer.resolve();
    await waitFor(() => expect(card()).not.toHaveAttribute('aria-busy'));
    expect(listed()).toHaveLength(2);
  });

  it('leaves loan ledger rows out of the list, as the totals leave them out (issue 200)', async () => {
    db.accounts = [
      ...db.accounts,
      { ...sampleCsvAccount, id: LOAN_ID, provider: 'plaid', name: 'Auto loan', kind: 'loan' },
    ];
    db.transactions = [
      {
        ...AMAZON,
        id: '7a000000-0000-4000-8000-00000000a002',
        account_id: LOAN_ID,
        merchant_raw: 'Interest charged',
        merchant_clean: 'Interest charged',
        merchant_norm: 'interest charged',
        posted_at: '2026-10-16',
      },
      ...db.transactions,
    ];
    const { user } = await renderSpending();
    await showAll(user);
    expect(listed()).toHaveLength(16);
    expect(screen.queryByRole('row', { name: /Interest charged/ })).not.toBeInTheDocument();
  });

  it('names the period when it has no transactions', async () => {
    const { user } = await renderSpending();
    await pickPeriod(user, 'July 2026');
    expect(
      await within(card()).findByText(
        'No transactions from July 1 to 31. Pick another period above.',
      ),
    ).toBeInTheDocument();
    expect(within(card()).queryByRole('link', { name: 'Link a bank' })).not.toBeInTheDocument();
  });

  it("lists the period's rows in a category's popover, however many newer rows there are", async () => {
    // Fifty newer rows fill the newest page, so the period's own rows are on none of it.
    db.transactions = [
      ...Array.from({ length: 50 }, (_, i) => ({
        ...sampleTransactions[i % 16]!,
        id: `7c000000-0000-4000-8000-${String(1000 - i).padStart(12, '0')}`,
      })),
      ...august(2),
    ];
    const { user } = await renderSpending({ showSankey: true });
    await pickPeriod(user, 'August 2026');
    const flow = () => screen.getByRole('region', { name: /Where each dollar/ });
    await screen.findByRole('heading', { name: 'Where each dollar of August pay went' });
    await waitFor(() => expect(flow()).not.toHaveAttribute('aria-busy'));
    await user.hover(within(flow()).getByRole('button', { name: 'Shopping $204.90' }));
    const popover = within(flow()).getByRole('group', { name: 'Shopping' });
    await waitFor(() =>
      expect(
        within(popover)
          .getAllByRole('listitem')
          .map((l) => l.textContent),
      ).toEqual([
        'August shop 1Our guess-$62.30Aug 20 · ··4821',
        'August shop 2Our guess-$62.30Aug 20 · ··4821',
      ]),
    );
  });

  it('lists the newest rows when the period cannot be read', async () => {
    server.use(
      http.get(apiUrl('/cashflow'), () =>
        HttpResponse.json({ error: { code: 'x', message: 'Database is busy' } }, { status: 503 }),
      ),
    );
    const reads = transactionReads();
    await renderSpending();
    expect(reads).toEqual([{ limit: '50', cash_accounts_only: 'true' }]);
    expect(listed()).toHaveLength(10);
  });
});
