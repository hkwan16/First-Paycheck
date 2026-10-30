import { delay, http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dynamicCashflow, emptyCashflow, sandboxCashflow } from '@/test/fixtures/cashflow';
import { SAMPLE_NOW, sampleCsvAccount, sampleTransactions } from '@/test/fixtures/sample';
import { db, emptyDb } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { spendingDb } from '@/test/msw/spending-handlers';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { SpendingScreen } from './SpendingScreen';

const row = (merchant: string, index = 0) =>
  screen.getAllByRole('row', { name: new RegExp(merchant) })[index]!;
const categoryOf = (merchant: string, index = 0) =>
  within(row(merchant, index)).getByRole('combobox', { name: `Category for ${merchant}` });

async function renderSpending(props: Parameters<typeof SpendingScreen>[0] = {}) {
  const rendered = renderWithProviders(<SpendingScreen {...props} />, {
    advanceTimers: vi.isFakeTimers() ? vi.advanceTimersByTime : undefined,
  });
  await screen.findAllByRole('row', { name: /Sweetgreen/ });
  return rendered;
}

afterEach(() => server.events.removeAllListeners());

const summaryRegion = () => screen.getByRole('region', { name: /paychecks?$|Your month so far/ });
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
    expect(summaryRegion()).toHaveAccessibleName('October 1 to 17 · 2 paychecks');
    expect(tile('Income')).toHaveTextContent('$3,992.08');
    expect(tile('Income')).toHaveTextContent('2 paychecks, after taxes and deductions');
    expect(tile('Essentials')).toHaveTextContent('$1,823.25');
    expect(tile('Essentials')).toHaveTextContent('46% of income');
    expect(tile('Flexible')).toHaveTextContent('$249.89');
    expect(tile('Flexible')).toHaveTextContent('6% of income');
    expect(tile('Savings')).toHaveTextContent('$300.00');
    expect(tile('Savings')).toHaveTextContent('Savings rate 8%');
    expect(summaryRegion()).toHaveTextContent(
      'Not yet spent: $1,618.94 is still in your accounts.',
    );
  });

  it('shows skeletons, never client sums, until the totals arrive', async () => {
    server.use(
      http.get(apiUrl('/cashflow'), async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    await renderSpending();
    const summary = screen.getByRole('region', { name: /Your month so far/ });
    expect(summary).toHaveAttribute('aria-busy', 'true');
    expect(summary).not.toHaveTextContent('$');
    expect(summary.querySelectorAll('[data-skeleton]').length).toBeGreaterThanOrEqual(8);
  });

  it('names the linked accounts the summary covers', async () => {
    await renderSpending();
    expect(summaryRegion()).toHaveTextContent('Chase ··4821 and ··7730');
  });

  it('says when more went out than came in', async () => {
    spendingDb.cashflow.spending.left_over_cents = -12_345;
    await renderSpending();
    expect(await within(summaryRegion()).findByText(/Spent more than came in/)).toHaveTextContent(
      'Spent more than came in: -$123.45 from your accounts.',
    );
  });

  it('says n/a for the shares when there was no income', async () => {
    spendingDb.cashflow = emptyCashflow('2026-10-01', '2026-10-17');
    await renderSpending();
    await waitFor(() => expect(tile('Essentials')).toHaveTextContent('$0.00'));
    expect(tile('Essentials')).toHaveTextContent('n/a, income too small to compare');
    expect(tile('Savings')).toHaveTextContent('n/a, income too small to compare');
  });

  it('says n/a for a share the API holds back as too large, and shows the rest', async () => {
    // Plaid's user_transactions_dynamic October (spec 007 rules 21a and 25):
    // 12 cents of income against $364.80 of essentials.
    spendingDb.cashflow = dynamicCashflow();
    await renderSpending();
    await waitFor(() => expect(tile('Income')).toHaveTextContent('$0.12'));
    expect(tile('Essentials')).toHaveTextContent('$364.80');
    expect(tile('Essentials')).toHaveTextContent('n/a, income too small to compare');
    expect(tile('Essentials')).not.toHaveTextContent('%');
    expect(tile('Flexible')).toHaveTextContent('-$1,019.79');
    expect(tile('Flexible')).toHaveTextContent('n/a, income too small to compare');
    expect(tile('Savings')).toHaveTextContent('Savings rate 0%');
  });

  it('says how many ledger rows the totals left out', async () => {
    spendingDb.cashflow = dynamicCashflow();
    await renderSpending();
    expect(
      await within(summaryRegion()).findByText(
        "165 rows on loan, investment and retirement accounts are left out: they are those accounts' own ledgers, not money you spent or received.",
      ),
    ).toBeInTheDocument();
  });

  it('says nothing about ledgers when none were left out', async () => {
    await renderSpending();
    await waitFor(() => expect(tile('Income')).toHaveTextContent('$3,992.08'));
    expect(summaryRegion()).not.toHaveTextContent(/left out/);
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
    await waitFor(() => expect(tile('Income')).toHaveTextContent('$3,992.08'));
  });

  it("picks a period: this month so far, the API's last complete month, or one before", async () => {
    const reads = cashflowReads();
    const { user } = await renderSpending();
    const picker = await screen.findByRole('combobox', { name: 'Period' });
    await waitFor(() => expect(picker).toHaveValue('2026-10'));
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
    ]);

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
    expect(within(card()).getByText('Scale: 1 px is about $14')).toBeInTheDocument();
    expect(node('Gross pay, 2 stubs $5,416.66')).toBeInTheDocument();
    expect(node('Take-home $3,992.08')).toBeInTheDocument();
    expect(within(card()).getByText('Pay stubs, October')).toBeInTheDocument();
  });

  it("lists a category's transactions in its popover, with who labeled each", async () => {
    const { user } = await renderSpending({ showSankey: true });
    await user.hover(await within(card()).findByRole('button', { name: 'Shopping $204.90' }));
    const popover = within(card()).getByRole('group', { name: 'Shopping' });
    expect(popover).toHaveTextContent('2 transactions in this period');
    const lines = within(popover).getAllByRole('listitem');
    expect(lines.map((l) => l.textContent)).toEqual([
      'Costco WholesaleAI · 62%-$142.60Oct 13 · ··4821',
      'AmazonAI · 78%-$62.30Oct 9 · ··4821',
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

  it('says n/a for a bucket whose share the API held back', async () => {
    spendingDb.cashflow = dynamicCashflow();
    const { user } = await renderSpending({ showSankey: true });
    await user.hover(await within(card()).findByRole('button', { name: 'Essentials $364.80' }));
    const popover = within(card()).getByRole('group', { name: 'Essentials' });
    expect(popover).toHaveTextContent('n/a, income too small to compare');
    expect(popover).not.toHaveTextContent('Debt payments');
  });

  it('explains take-home from both sides: the pay stubs and the deposits', async () => {
    const { user } = await renderSpending({ showSankey: true });
    await user.hover(await within(card()).findByRole('button', { name: 'Take-home $3,992.08' }));
    const popover = within(card()).getByRole('group', { name: 'Take-home' });
    expect(popover).toHaveTextContent('Net pay on 2 pay stubs: $3,992.08');
    expect(popover).toHaveTextContent('Deposited as income: $3,992.08');
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

  it('draws spending with no pay stub or income, with no scale to give', async () => {
    // What the e2e sandbox user's September looks like: a few charges, no deposits.
    const flow = emptyCashflow('2026-09-01', '2026-09-30');
    flow.spending = {
      ...flow.spending,
      essentials_cents: 633,
      flexible_cents: 50_000,
      left_over_cents: -50_633,
      transaction_count: 3,
      categories: [
        { category: 'transport', bucket: 'essentials', total_cents: 633, count: 1 },
        { category: 'travel', bucket: 'flexible', total_cents: 50_000, count: 2 },
      ],
    };
    spendingDb.cashflow = flow;
    await renderSpending({ showSankey: true });
    expect(await within(card()).findByRole('button', { name: 'Essentials $6.33' })).toBeVisible();
    expect(node('No confirmed pay stub $0.00')).toBeInTheDocument();
    expect(node('Income deposited $0.00')).toBeInTheDocument();
    expect(node('Flexible $500.00')).toBeInTheDocument();
    expect(node('Spent beyond income -$506.33')).toBeInTheDocument();
    expect(within(card()).queryByText(/1 px is about/)).not.toBeInTheDocument();
  });

  it('draws the sandbox month the API counts money in for, at a scale its tallest node sets', async () => {
    // The production walkthrough's month: GUSTO PAY is booked as money out,
    // so income is the 4.22 of interest that came in (spec 007 rule 22a).
    spendingDb.cashflow = sandboxCashflow();
    await renderSpending({ showSankey: true });
    expect(await within(card()).findByRole('button', { name: 'Savings $1,000.00' })).toBeVisible();
    expect(node('Income deposited $4.22')).toBeInTheDocument();
    expect(node('Spent beyond income -$1,685.41')).toBeInTheDocument();
    expect(tile('Income')).toHaveTextContent('$4.22');
    // Savings, the tallest node, is drawn 400 px tall: $1,000.00 / 400 is $2.50,
    // shown in whole dollars. (Scaled by the $4.22 of income, it read "$0.01".)
    expect(within(card()).getByText('Scale: 1 px is about $3')).toBeInTheDocument();
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
  it('lists every transaction newest first with date, merchant, account, source, category and amount', async () => {
    await renderSpending();
    const table = screen.getByRole('table', { name: 'Transactions' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(16);

    const [latest] = rows;
    expect(within(latest!).getByText('Oct 17')).toBeInTheDocument();
    expect(within(latest!).getByText("Trader Joe's")).toBeInTheDocument();
    expect(within(latest!).getByText('··4821')).toBeInTheDocument();
    expect(within(latest!).getByText('Rule')).toBeInTheDocument();
    expect(categoryOf("Trader Joe's")).toHaveValue('groceries');
    expect(within(latest!).getByText('-$91.33')).toBeInTheDocument();

    expect(within(row('Acme Corp Payroll')).getByText('+$1,996.04')).toHaveClass('text-plum-text');
    expect(within(row('Sweetgreen')).getByText('AI · 91%')).toHaveClass('bg-blue-tint');
    expect(within(row('Costco Wholesale')).getByText('AI · 62%')).toBeInTheDocument();
    expect(within(row('Blue Bottle Coffee')).getByText('You')).toBeInTheDocument();
  });

  it('counts the labels by source', async () => {
    await renderSpending();
    const card = screen.getByRole('region', { name: 'Transactions' });
    expect(within(card).getByText('11 by rule')).toBeInTheDocument();
    expect(within(card).getByText('4 by AI')).toBeInTheDocument();
    expect(within(card).getByText('1 fixed by you')).toBeInTheDocument();
  });

  it('applies a fix at once, then confirms it was saved as a rule', async () => {
    server.use(
      http.patch(apiUrl('/transactions/:id'), async ({ params, request }) => {
        await delay(150);
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
    expect(screen.queryByText(/Saved as a rule/)).not.toBeInTheDocument();

    expect(await screen.findByText(/Saved as a rule/)).toHaveTextContent(
      'Saved as a rule. Sweetgreen will never go back to the AI for you.',
    );
    expect(
      within(screen.getByRole('region', { name: 'Transactions' })).getByText('2 fixed by you'),
    ).toBeInTheDocument();
  });

  it("relabels the merchant's other rows too and says how many", async () => {
    const { user } = await renderSpending();
    await user.selectOptions(categoryOf("Trader Joe's", 0), ['Dining']);
    await waitFor(() => expect(categoryOf("Trader Joe's", 1)).toHaveValue('dining'));
    expect(within(row("Trader Joe's", 1)).getByText('Rule')).toBeInTheDocument();
    expect(await screen.findByText(/Saved as a rule/)).toHaveTextContent(
      "Saved as a rule. Trader Joe's will never go back to the AI for you. 1 other transaction was relabeled.",
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
    expect(within(row('Sweetgreen')).getByText('AI · 91%')).toBeInTheDocument();
    expect(screen.queryByText(/Saved as a rule/)).not.toBeInTheDocument();
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
    expect(within(table).getAllByRole('row')).toHaveLength(51);
    expect(screen.getByText('Counts cover the 50 transactions loaded so far.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more transactions' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(61));
    expect(
      screen.queryByRole('button', { name: 'Load more transactions' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/loaded so far/)).not.toBeInTheDocument();
  });

  it('points to the first step when there is nothing to show', async () => {
    emptyDb();
    renderWithProviders(<SpendingScreen />);
    expect(await screen.findByText(/No transactions yet/)).toBeInTheDocument();
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
