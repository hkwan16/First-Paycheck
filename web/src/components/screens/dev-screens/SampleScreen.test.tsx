import { QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccounts } from '@/lib/api/hooks';
import { SAMPLE_NOW, sampleAccounts } from '@/test/fixtures/sample';
import { server } from '@/test/msw/server';
import { SampleScreen, seededClient } from './SampleScreen';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
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

  it('renders the Confirm screen on the sample stub, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="confirm" />);
    const fields = await screen.findByRole('region', { name: 'Extracted fields' });
    expect(within(fields).getAllByRole('group')).toHaveLength(14);
    expect(screen.getByText('2 items redacted')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Confirm pay stub' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(requests).toEqual([]);
  });

  it('renders the manual entry variant with every field open, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="confirm-manual" />);
    const fields = await screen.findByRole('region', { name: 'Pay stub fields' });
    expect(within(fields).getAllByRole('textbox')).toHaveLength(10);
    expect(requests).toEqual([]);
  });
});

describe('seededClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('seeds every query at the sample time without reading the clock', () => {
    // It runs while the page renders: next dev prerenders the route to
    // validate it, and reports a Date.now() there as an unstable value.
    const now = vi.spyOn(Date, 'now');
    const client = seededClient();
    expect(now).not.toHaveBeenCalled();
    const queries = client.getQueryCache().getAll();
    expect(queries.length).toBeGreaterThan(5);
    for (const query of queries) {
      expect(query.state.dataUpdatedAt, JSON.stringify(query.queryKey)).toBe(
        Date.parse(SAMPLE_NOW),
      );
    }
  });

  it('serves reads without asking the clock whether the data is stale', () => {
    // A numeric staleTime, even Infinity, makes every useQuery render compare
    // the data's age with Date.now().
    const client = seededClient();
    const now = vi.spyOn(Date, 'now');
    const { result } = renderHook(() => useAccounts(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    expect(result.current.data).toHaveLength(sampleAccounts.length);
    expect(now).not.toHaveBeenCalled();
  });
});
