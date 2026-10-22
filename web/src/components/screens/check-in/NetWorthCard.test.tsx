import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyNetWorth, sampleHoldings } from '@/test/fixtures/checkins';
import { checkinDb } from '@/test/msw/checkin-handlers';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderWithProviders as render, screen, within } from '@/test/render';
import { NetWorthCard } from './NetWorthCard';

afterEach(() => server.events.removeAllListeners());

async function open() {
  const view = render(<NetWorthCard />);
  const card = screen.getByRole('region', { name: 'Net worth' });
  const asOf = await within(card).findByText('As of Nov 15, 2026');
  // The headline, above the date it was read on.
  expect(asOf.previousElementSibling).toHaveTextContent('$5,477.54');
  return { ...view, card };
}

describe('NetWorthCard', () => {
  it('shows net worth, assets and liabilities and the change over the series, as the API sends them', async () => {
    const asked: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/net-worth') asked.push(url.search);
    });
    const { card } = await open();
    expect(within(card).getByText('+$977.54 since Sep 2026')).toBeInTheDocument();
    const term = (name: string) => within(card).getByText(name, { selector: 'dt' });
    expect(term('Assets').nextElementSibling).toHaveTextContent('$6,077.54');
    expect(term('Liabilities').nextElementSibling).toHaveTextContent('$600.00');
    expect(asked).toEqual(['?months=12']);
  });

  it('lists each account with its role (or kind) and balance, a liability as owed', async () => {
    const { card } = await open();
    const accounts = within(card).getByRole('list', { name: 'Accounts' });
    const items = within(accounts).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Acme 401(k)Retirement$217.10',
      'Chase Savings··7730Emergency fund$2,740.00',
      'Chase Total Checking··4821Spending$3,120.44',
      'Freedom Unlimited··1234Credit card · owed$600.00',
    ]);
  });

  it('draws the monthly series with a legend, and lists every month in a table', async () => {
    const { card, user } = await open();
    const chart = within(card).getByRole('figure', { name: 'Net worth by month' });
    const legend = within(chart).getByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((i) => i.textContent),
    ).toEqual(['Net worth', 'Assets', 'Liabilities']);
    expect(chart.querySelectorAll('.recharts-line')).toHaveLength(3);

    await user.click(within(card).getByText('Monthly figures'));
    const table = within(card).getByRole('table', { name: 'Net worth by month' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Sep 2026$4,500.00$0.00$4,500.00',
      'Oct 2026$5,100.00$450.00$4,650.00',
      'Nov 2026$6,077.54$600.00$5,477.54',
    ]);
  });

  it('shows the investment holdings', async () => {
    const { card } = await open();
    expect(await within(card).findByRole('table', { name: 'Holdings' })).toHaveTextContent(
      'Vanguard Target Retirement 2070 Fund',
    );
  });

  it('says there are no holdings when no investment account reports any', async () => {
    checkinDb.holdings = {
      ...sampleHoldings(),
      accounts: [],
      value_cents: 0,
      cost_basis_cents: 0,
      gain_cents: 0,
    };
    const { card } = await open();
    expect(await within(card).findByText(/No investment holdings reported/)).toBeInTheDocument();
    expect(within(card).queryByRole('table', { name: 'Holdings' })).toBeNull();
  });

  it('explains an empty net worth instead of drawing zeros', async () => {
    checkinDb.netWorth = emptyNetWorth();
    render(<NetWorthCard />);
    const card = screen.getByRole('region', { name: 'Net worth' });
    expect(await within(card).findByText(/No balances yet/)).toBeInTheDocument();
    expect(within(card).queryByRole('figure')).toBeNull();
    expect(within(card).getByRole('link', { name: 'Link an account' })).toHaveAttribute(
      'href',
      '/setup/link',
    );
  });

  it('leaves out the change when there is only one month', async () => {
    checkinDb.netWorth = { ...checkinDb.netWorth, change_cents: null };
    const { card } = await open();
    expect(within(card).queryByText(/ since /)).toBeNull();
  });

  it('says when net worth could not load', async () => {
    server.use(
      http.get(apiUrl('/net-worth'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Something went wrong.' } },
          { status: 500 },
        ),
      ),
    );
    render(<NetWorthCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  });
});
