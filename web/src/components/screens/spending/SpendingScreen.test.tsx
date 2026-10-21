import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleTransactions } from '@/test/fixtures/sample';
import { db, emptyDb } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { SpendingScreen } from './SpendingScreen';

const row = (merchant: string, index = 0) =>
  screen.getAllByRole('row', { name: new RegExp(merchant) })[index]!;
const categoryOf = (merchant: string, index = 0) =>
  within(row(merchant, index)).getByRole('combobox', { name: `Category for ${merchant}` });

async function renderSpending() {
  const rendered = renderWithProviders(<SpendingScreen />);
  await screen.findAllByRole('row', { name: /Sweetgreen/ });
  return rendered;
}

afterEach(() => server.events.removeAllListeners());

describe('SpendingScreen summary', () => {
  it('shows the four bucket tiles as skeletons until the summary route exists', async () => {
    await renderSpending();
    const summary = screen.getByRole('region', { name: /Your month so far/ });
    expect(summary).toHaveAttribute('aria-busy', 'true');
    for (const label of ['Income', 'Essentials', 'Flexible', 'Savings']) {
      expect(within(summary).getByText(label)).toBeInTheDocument();
    }
    // No total is computed on the client: no dollar amount appears.
    expect(summary).not.toHaveTextContent('$');
    expect(summary.querySelectorAll('[data-skeleton]').length).toBeGreaterThanOrEqual(8);
  });

  it('names the linked accounts the summary covers', async () => {
    await renderSpending();
    const summary = screen.getByRole('region', { name: /Your month so far/ });
    expect(summary).toHaveTextContent('Chase ··4821 and ··7730');
  });

  it('has no cash flow diagram while the sankey flag is off', async () => {
    await renderSpending();
    expect(screen.queryByRole('heading', { name: /Where each dollar/ })).not.toBeInTheDocument();
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
      '/setup/decisions',
    );
  });
});
