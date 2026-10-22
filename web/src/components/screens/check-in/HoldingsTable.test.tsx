import { describe, expect, it } from 'vitest';
import { partialBasisHoldings, sampleHoldings } from '@/test/fixtures/checkins';
import { render, screen, within } from '@/test/render';
import { HoldingsTable } from './HoldingsTable';

const row = (name: RegExp) => screen.getByRole('row', { name });

describe('HoldingsTable', () => {
  it('shows each position with its value, cost basis and gain as the API returns them', () => {
    render(<HoldingsTable holdings={sampleHoldings()} />);
    const table = screen.getByRole('table', { name: 'Holdings' });
    expect(within(table).getByRole('columnheader', { name: 'Cost basis' })).toBeInTheDocument();
    expect(within(table).getByText('Acme 401(k) · as of Nov 15, 2026')).toBeInTheDocument();
    const fund = row(/^Vanguard Target Retirement 2070 Fund/);
    expect(fund).toHaveTextContent('VSVNX');
    expect(fund).toHaveTextContent('14.21 shares');
    expect(fund).toHaveTextContent('$217.10');
    expect(fund).toHaveTextContent('$216.68');
    expect(fund).toHaveTextContent('+$0.42');
    // One account with one position: no subtotal or total rows repeating it.
    expect(within(table).queryByRole('row', { name: /total/ })).toBeNull();
  });

  it('says "Not reported" where the institution sent no basis, for the position, account and total', () => {
    render(<HoldingsTable holdings={partialBasisHoldings()} />);
    const vxus = row(/^Vanguard Total International Stock ETF/);
    expect(vxus).toHaveTextContent('$300.00');
    expect(within(vxus).getAllByText('Not reported')).toHaveLength(2);

    const vti = row(/^Vanguard Total Stock Market ETF/);
    expect(vti).toHaveTextContent('3.5 shares');
    expect(vti).toHaveTextContent('+$80.00');

    const brokerage = row(/^Brokerage total/);
    expect(brokerage).toHaveTextContent('$1,280.00');
    expect(within(brokerage).getAllByText('Not reported')).toHaveLength(2);

    const total = row(/^All accounts/);
    expect(total).toHaveTextContent('$1,497.10');
    expect(within(total).getAllByText('Not reported')).toHaveLength(2);
  });

  it('names a single share in the singular', () => {
    const holdings = sampleHoldings();
    holdings.accounts[0]!.holdings[0]!.quantity = '1';
    render(<HoldingsTable holdings={holdings} />);
    expect(row(/^Vanguard Target Retirement 2070 Fund/)).toHaveTextContent('1 share');
  });
});
