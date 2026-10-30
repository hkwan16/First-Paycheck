import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS } from '@/lib/api/hooks';
import { dynamicCashflow } from '@/test/fixtures/cashflow';
import {
  checkInJobId,
  checkInJobStates,
  completedNovemberCheckIn,
  NOVEMBER_ID,
  novemberCalendar,
  novemberCheckIn,
} from '@/test/fixtures/checkins';
import { checkinDb } from '@/test/msw/checkin-handlers';
import { db } from '@/test/msw/db';
import { apiUrl, scriptJob } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { act, renderWithProviders as render, screen, waitFor, within } from '@/test/render';
import { CheckInScreen } from './CheckInScreen';

const ELECTION_TITLE = 'Your 401(k) contribution is 2%, not the 4% you chose.';

/** PATCH bodies sent to findings. */
function patches() {
  const bodies: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'PATCH') bodies.push(await request.clone().json());
  });
  return bodies;
}

afterEach(() => server.events.removeAllListeners());

async function open(id = NOVEMBER_ID) {
  const view = render(<CheckInScreen checkInId={id} />);
  await screen.findByRole('heading', { level: 1, name: 'November check-in' });
  const findings = await screen.findByRole('region', { name: 'What changed' });
  return { ...view, findings };
}

const finding = (name: string) => screen.getByRole('listitem', { name });
const handledBadge = (region: HTMLElement) => within(region).getByText(/ of \d+ handled$/);

describe('CheckInScreen', () => {
  it('lists the findings in the order the API returns them, with their counts', async () => {
    const { findings } = await open();
    const items = within(within(findings).getByRole('list', { name: 'Findings' })).getAllByRole(
      'listitem',
    );
    expect(items.map((item) => item.getAttribute('aria-label') ?? item.textContent)).toHaveLength(
      9,
    );
    expect(within(items[0]!).getByText(ELECTION_TITLE)).toBeInTheDocument();
    expect(within(items[0]!).getByText('Election not applied')).toBeInTheDocument();
    expect(
      within(items[8]!).getByText('Health premiums went from $62.50 to $31.25.'),
    ).toBeVisible();
    expect(handledBadge(findings)).toHaveTextContent('0 of 9 handled');
    expect(screen.getByText(/Compared with your plan on Nov 16, 2026/)).toBeInTheDocument();
  });

  it('links each finding to the part of the plan it affects', async () => {
    await open();
    expect(
      within(finding(ELECTION_TITLE)).getByRole('link', { name: 'Affects: 401(k) match' }),
    ).toHaveAttribute('href', '/setup/decisions/401k');
    expect(
      within(finding('Equinox, $185.00, looks monthly.')).getByRole('link', {
        name: 'Affects: Spending map',
      }),
    ).toHaveAttribute('href', '/setup/spending');
  });

  it('marks a finding done at once, moves focus to Undo, then undoes it', async () => {
    const sent = patches();
    const { user, findings } = await open();
    const row = finding(ELECTION_TITLE);

    await user.click(within(row).getByRole('button', { name: 'Done' }));
    const undo = within(row).getByRole('button', { name: 'Undo' });
    expect(undo).toHaveFocus();
    expect(within(row).getByText('Done', { selector: 'span' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(handledBadge(findings)).toHaveTextContent('1 of 9 handled');
    expect(within(findings).getByRole('status')).toHaveTextContent(
      `Marked done: ${ELECTION_TITLE}`,
    );

    await user.click(undo);
    expect(within(row).getByRole('button', { name: 'Done' })).toHaveFocus();
    expect(handledBadge(findings)).toHaveTextContent('0 of 9 handled');
    await waitFor(() => expect(sent).toEqual([{ user_action: 'done' }, { user_action: null }]));
  });

  it('dismisses a finding', async () => {
    const sent = patches();
    const { user } = await open();
    const row = finding('Equinox, $185.00, looks monthly.');
    await user.click(within(row).getByRole('button', { name: 'Dismiss' }));
    expect(within(row).getByText('Dismissed')).toBeInTheDocument();
    await waitFor(() => expect(sent).toEqual([{ user_action: 'dismissed' }]));
    await waitFor(() => expect(checkinDb.checkIns[0]!.handled_count).toBe(1));
  });

  it('puts a finding back and says so when the server refuses', async () => {
    server.use(
      http.patch(apiUrl('/check-ins/:id/findings/:fid'), async () => {
        await delay(100);
        return HttpResponse.json(
          { error: { code: 'internal_error', message: 'Something went wrong.' } },
          { status: 500 },
        );
      }),
    );
    const { user, findings } = await open();
    const row = finding(ELECTION_TITLE);
    await user.click(within(row).getByRole('button', { name: 'Done' }));
    expect(handledBadge(findings)).toHaveTextContent('1 of 9 handled');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Could not save “${ELECTION_TITLE}”. It is back to how it was. Something went wrong.`,
    );
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Done' })).toHaveFocus());
    expect(handledBadge(findings)).toHaveTextContent('0 of 9 handled');
  });

  it('completes the check-in when the last finding is handled', async () => {
    const done = completedNovemberCheckIn();
    const last = done.findings.at(-1)!;
    checkinDb.checkIns[0] = {
      ...done,
      status: 'open',
      completed_at: null,
      handled_count: 8,
      findings: done.findings.map((f) =>
        f.id === last.id ? { ...f, user_action: null, user_action_at: null } : f,
      ),
    };
    const { user, findings } = await open();
    const row = finding('Health premiums went from $62.50 to $31.25.');
    await user.click(within(row).getByRole('button', { name: 'Done' }));
    expect(handledBadge(findings)).toHaveTextContent('9 of 9 handled');
    expect(within(findings).getByText(/Every finding is handled/)).toBeInTheDocument();
  });

  it('shows a completed check-in with every finding handled and each one undoable', async () => {
    checkinDb.checkIns[0] = completedNovemberCheckIn();
    const { findings } = await open();
    expect(handledBadge(findings)).toHaveTextContent('9 of 9 handled');
    expect(
      within(findings).getByText(/Every finding is handled\. Completed Nov 16, 2026\./),
    ).toBeInTheDocument();
    expect(within(findings).getAllByRole('button', { name: 'Undo' })).toHaveLength(9);
    expect(within(findings).getAllByText('Dismissed')).toHaveLength(1);
  });

  it('says so when the month brought nothing to look at', async () => {
    checkinDb.checkIns[0] = novemberCheckIn({ findings: [], finding_count: 0 });
    const { findings } = await open();
    expect(within(findings).getByText(/Nothing changed against your plan/)).toBeInTheDocument();
  });

  it('shows the month’s cash flow next to the plan, from the API’s lines', async () => {
    await open();
    const card = await screen.findByRole('region', {
      name: 'November cash flow against the plan',
    });
    expect(within(card).getByText('November 1 to 16 · 1 pay stub')).toBeInTheDocument();
    const row = within(card).getByRole('row', { name: /^401\(k\) from pay stubs/ });
    expect(row).toHaveTextContent('$54.17');
    expect(row).toHaveTextContent('$108.33');
    expect(row).toHaveTextContent('-$54.16');
    const bar = within(card).getByRole('progressbar', {
      name: '401(k) from pay stubs against plan',
    });
    expect(bar).toHaveAttribute('aria-valuetext', '$54.17 of $108.33 planned');
    // The API's status, in words beside the actual.
    expect(within(row).getByText('Under plan')).toBeVisible();
    expect(within(card).getByRole('row', { name: /^Health premiums/ })).toHaveTextContent(
      'On plan',
    );
    // A line with no plan has no target, no bar and no status.
    const flexible = within(card).getByRole('row', { name: /^Flexible/ });
    expect(flexible).toHaveTextContent('No target');
    expect(flexible).not.toHaveTextContent(/(On|Over|Under) plan/);
    expect(within(card).queryByRole('progressbar', { name: 'Flexible against plan' })).toBeNull();
    expect(within(card).getAllByRole('progressbar')).toHaveLength(4);
    expect(within(card).getByRole('link', { name: 'Open the Spending map' })).toHaveAttribute(
      'href',
      '/setup/spending',
    );
  });

  it('says which ledger rows the cash flow left out, and shows no share it was not sent', async () => {
    // The user_transactions_dynamic shape (spec 007 rules 21a and 25): loan
    // ledgers left out, 12 cents of income, no essentials or flexible share.
    const checkIn = novemberCheckIn();
    const spending = checkIn.cash_flow.cash_flow.spending;
    checkIn.cash_flow.cash_flow.spending = {
      ...spending,
      ...dynamicCashflow().spending,
      start: spending.start,
      end: spending.end,
    };
    checkinDb.checkIns[0] = checkIn;
    await open();
    const card = await screen.findByRole('region', {
      name: 'November cash flow against the plan',
    });
    expect(card).toHaveTextContent(
      "165 rows on loan, investment and retirement accounts are left out: they are those accounts' own ledgers, not money you spent or received.",
    );
    expect(card).not.toHaveTextContent('%');
  });

  it('says nothing about ledgers when none were left out', async () => {
    await open();
    const card = await screen.findByRole('region', {
      name: 'November cash flow against the plan',
    });
    expect(card).not.toHaveTextContent(/left out/);
  });

  it('shows net worth and holdings beside the cash flow, as the mockup places them', async () => {
    await open();
    const card = await screen.findByRole('region', { name: 'Net worth' });
    expect(await within(card).findByText('As of Nov 15, 2026')).toBeInTheDocument();
    expect(await within(card).findByRole('table', { name: 'Holdings' })).toBeInTheDocument();
  });

  it('lists the dates due from the first of the month to the end of the next', async () => {
    db.calendar = [
      ...novemberCalendar(),
      {
        ...novemberCalendar()[0]!,
        id: 'ca000000-0000-4000-8000-000000000099',
        due_at: '2027-01-05',
      },
    ];
    const asked: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/calendar') asked.push(url.search);
    });
    await open();
    const card = await screen.findByRole('region', { name: 'Coming up' });
    await within(card).findByText('Health plan enrollment deadline');
    expect(within(card).getAllByRole('listitem')).toHaveLength(3);
    expect(asked).toEqual(['?from=2026-11-01&to=2026-12-31']);
  });

  it('says a check-in it cannot find is not there, and links to the list', async () => {
    render(<CheckInScreen checkInId="c1000000-0000-4000-8000-00000000ffff" />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check-in not found' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all check-ins' })).toHaveAttribute(
      'href',
      '/check-in',
    );
  });
});

describe('Check in now on a check-in', () => {
  afterEach(() => vi.useRealTimers());

  const at = (now: string) => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(now) });
  const openAt = async () => {
    const view = render(<CheckInScreen checkInId={NOVEMBER_ID} />, {
      advanceTimers: vi.advanceTimersByTime,
    });
    await screen.findByRole('heading', { level: 1, name: 'November check-in' });
    await screen.findByRole('region', { name: 'What changed' });
    return view;
  };

  it('runs this month’s open check-in again, follows the job and reads it again', async () => {
    at('2026-11-16T18:00:00Z');
    // Issue 171: a run that changes nothing moves last_run_at, not updated_at.
    scriptJob(checkInJobStates(checkInJobId(1)), () => {
      checkinDb.checkIns[0]!.last_run_at = '2026-11-18T09:00:00Z';
    });
    const { user } = await openAt();
    expect(screen.getByText(/Compared with your plan on Nov 16, 2026/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check in now' }));
    expect(await screen.findByRole('progressbar', { name: 'Checking in' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));

    expect(
      await screen.findByText('Checked again just now. This page is up to date.'),
    ).toBeInTheDocument();
    // The check-in was read again: the date it was compared on is the run's.
    expect(await screen.findByText(/Compared with your plan on Nov 18, 2026/)).toBeInTheDocument();
    expect(checkinDb.checkIns[0]!.updated_at).toBe(novemberCheckIn().updated_at);
    // It is this check-in, so there is nothing to open.
    expect(screen.queryByRole('link', { name: 'Open it' })).toBeNull();
  });

  it('is not offered on a completed check-in, which a run would leave as it is', async () => {
    at('2026-11-16T18:00:00Z');
    checkinDb.checkIns[0] = completedNovemberCheckIn();
    await openAt();
    expect(screen.queryByRole('button', { name: 'Check in now' })).toBeNull();
    expect(screen.getByRole('link', { name: 'All check-ins' })).toBeInTheDocument();
  });

  it('is not offered on another month’s check-in, since it runs this month’s', async () => {
    at('2026-12-02T09:00:00Z');
    await openAt();
    expect(screen.queryByRole('button', { name: 'Check in now' })).toBeNull();
  });
});
