import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { server } from '@/test/msw/server';
import { SampleScreen } from './SampleScreen';

vi.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false, error: null, exit: vi.fn() }),
}));

function countRequests() {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  return seen;
}

describe('SampleScreen', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
  afterEach(() => {
    vi.useRealTimers();
    server.events.removeAllListeners();
  });

  it('renders the Link screen in the app frame from the sample data, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="link" />);
    expect(screen.getByText('Acme Corp · Semi-monthly')).toBeInTheDocument();
    expect(screen.getByText('J. Rivera')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Accounts and documents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const checking = await screen.findByRole('group', { name: 'Chase Total Checking' });
    expect(checking).toHaveTextContent('16 transactions since Oct 2026');
    expect(requests).toEqual([]);
  });

  it('renders the Spending screen from the sample data, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="spending" />);
    const table = await screen.findByRole('table', { name: 'Transactions' });
    expect(within(table).getAllByRole('row')).toHaveLength(17);
    expect(screen.getByRole('link', { name: 'Spending map' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(requests).toEqual([]);
  });
});
