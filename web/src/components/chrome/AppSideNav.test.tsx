import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markPageHydrated, resetPageHydration } from '@/lib/page-hydration';
import { NOVEMBER_ID } from '@/test/fixtures/checkins';
import { samplePayStub } from '@/test/fixtures/documents';
import { db, savedDecision } from '@/test/msw/db';
import { partialPlan } from '@/test/fixtures/plan';
import { planDb } from '@/test/msw/plan-handlers';
import { server } from '@/test/msw/server';
import { act, renderWithProviders as render, screen, waitFor } from '@/test/render';
import { AppSideNav } from './AppSideNav';

const pathname = vi.hoisted(() => ({ current: '/setup/spending' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

describe('AppSideNav', () => {
  beforeEach(() => markPageHydrated());
  afterEach(() => {
    resetPageHydration();
    server.events.removeAllListeners();
  });

  it('marks the screen for the current path', () => {
    pathname.current = '/setup/spending';
    render(<AppSideNav />);
    expect(screen.getByRole('link', { name: 'Spending map' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the decision step for the current path, not Decisions (spec 018 rule 7)', () => {
    pathname.current = '/setup/decisions/w4';
    render(<AppSideNav />);
    expect(screen.getByRole('link', { name: 'W-4' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Decisions' })).not.toHaveAttribute('aria-current');
  });

  it('checks off a step once GET /decisions has its calculator (spec 018 rule 8)', async () => {
    savedDecision();
    pathname.current = '/setup/decisions/401k';
    render(<AppSideNav />);
    expect(await screen.findByRole('link', { name: '401(k) match, done' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Emergency fund' })).toBeInTheDocument();
  });

  it('closes the phone nav when the path changes (spec 018 rule 15)', async () => {
    pathname.current = '/setup/spending';
    const { user, rerender } = render(<AppSideNav />);
    const control = screen.getByRole('button', { name: /^Spending map, / });
    await user.click(control);
    expect(control).toHaveAttribute('aria-expanded', 'true');
    pathname.current = '/setup/decisions/401k';
    rerender(<AppSideNav />);
    expect(screen.getByRole('button', { name: /^Decisions: 401\(k\) match/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('passes done marks through', () => {
    pathname.current = '/plan';
    render(<AppSideNav done={{ link: true }} />);
    expect(screen.getByRole('link', { name: 'Accounts and documents, done' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Plan and calendar' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('derives done marks from API data', async () => {
    pathname.current = '/setup/link';
    db.payStubs = [samplePayStub()];
    render(<AppSideNav />);
    // Accounts (GET /accounts) and a document (GET /docs): step 1 is done.
    expect(
      await screen.findByRole('link', { name: 'Accounts and documents, done' }),
    ).toBeInTheDocument();
    // A confirmed pay stub (GET /pay-stubs): step 2 is done.
    await waitFor(() =>
      expect(screen.getByText('Confirm pay stub').closest('li')).toHaveTextContent(
        'Confirm pay stub, done',
      ),
    );
    // Transactions, and a summary (GET /spending/summary) with none uncategorized: step 3 is done.
    expect(await screen.findByRole('link', { name: 'Spending map, done' })).toBeInTheDocument();
  });

  it('marks the plan done when GET /plan says no decision is missing', async () => {
    pathname.current = '/setup/link';
    render(<AppSideNav />);
    expect(await screen.findByRole('link', { name: 'Plan and calendar, done' })).toHaveAttribute(
      'href',
      '/plan',
    );
  });

  it('leaves the plan open while a decision is missing from it', async () => {
    planDb.plan = partialPlan();
    pathname.current = '/setup/link';
    render(<AppSideNav />);
    await screen.findByRole('link', { name: 'Accounts and documents, done' });
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Plan and calendar' })).toBeInTheDocument(),
    );
  });

  it('links the monthly check-in to the newest open one once the list arrives', async () => {
    pathname.current = '/setup/link';
    render(<AppSideNav />);
    // Before the list arrives (and on the server), the item opens the list.
    expect(screen.getByRole('link', { name: 'Monthly check-in' })).toHaveAttribute(
      'href',
      '/check-in',
    );
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Monthly check-in' })).toHaveAttribute(
        'href',
        `/check-in/${NOVEMBER_ID}`,
      ),
    );
  });

  it('marks the monthly check-in current on the list of check-ins', () => {
    pathname.current = '/check-in';
    render(<AppSideNav />);
    expect(screen.getByRole('link', { name: 'Monthly check-in' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks nothing done before the data arrives', () => {
    pathname.current = '/setup/link';
    render(<AppSideNav />);
    expect(screen.getByRole('link', { name: 'Accounts and documents' })).toBeInTheDocument();
  });

  it('reads nothing from the API until the page below it has hydrated', async () => {
    // The layout hydrates before the page. Had the nav fetched /accounts first,
    // the page would hydrate with that data while its server HTML showed a
    // skeleton: a hydration mismatch (found by e2e/alpha.spec.ts).
    resetPageHydration();
    const requests: string[] = [];
    server.events.on('request:start', ({ request }) => {
      requests.push(new URL(request.url).pathname);
    });
    pathname.current = '/setup/link';
    const { queryClient } = render(<AppSideNav />);
    expect(screen.getByRole('link', { name: 'Accounts and documents' })).toBeInTheDocument();
    // Queries register while rendering, so an empty cache means no read started.
    expect(queryClient.getQueryCache().getAll()).toEqual([]);

    act(() => markPageHydrated());
    expect(
      await screen.findByRole('link', { name: 'Accounts and documents, done' }),
    ).toBeInTheDocument();
    expect(requests).toContain('/accounts');
  });
});
