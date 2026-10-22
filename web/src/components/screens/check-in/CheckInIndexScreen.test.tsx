import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS } from '@/lib/api/hooks';
import {
  checkInJob,
  checkInJobId,
  checkInJobStates,
  completedNovemberCheckIn,
  NOVEMBER_ID,
  novemberCheckIn,
  OCTOBER_ID,
} from '@/test/fixtures/checkins';
import { checkinDb } from '@/test/msw/checkin-handlers';
import { apiUrl, scriptJob } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { act, renderWithProviders as render, screen, waitFor, within } from '@/test/render';
import { CheckInIndexScreen } from './CheckInIndexScreen';

describe('CheckInIndexScreen', () => {
  it('lists check-ins newest first with their finding and handled counts', async () => {
    render(<CheckInIndexScreen />);
    expect(screen.getByRole('heading', { level: 1, name: 'Monthly check-ins' })).toBeVisible();
    const list = await screen.findByRole('list', { name: 'Check-ins' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);

    expect(within(items[0]!).getByRole('link', { name: 'November 2026' })).toHaveAttribute(
      'href',
      `/check-in/${NOVEMBER_ID}`,
    );
    expect(items[0]).toHaveTextContent('9 findings');
    expect(items[0]).toHaveTextContent('0 of 9 handled');
    expect(items[0]).toHaveTextContent('Open');

    expect(within(items[1]!).getByRole('link', { name: 'October 2026' })).toHaveAttribute(
      'href',
      `/check-in/${OCTOBER_ID}`,
    );
    expect(items[1]).toHaveTextContent('2 findings');
    expect(items[1]).toHaveTextContent('2 of 2 handled');
    expect(items[1]).toHaveTextContent('Completed Oct 20, 2026');
  });

  it('explains when the first check-in will come', async () => {
    checkinDb.checkIns = [];
    render(<CheckInIndexScreen />);
    expect(await screen.findByText(/No check-in yet\./)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Check-ins' })).toBeNull();
  });

  it('shows net worth even before the first check-in', async () => {
    checkinDb.checkIns = [];
    render(<CheckInIndexScreen />);
    const card = screen.getByRole('region', { name: 'Net worth' });
    expect(await within(card).findByText('As of Nov 15, 2026')).toBeInTheDocument();
  });

  it('says when the list could not load', async () => {
    server.use(
      http.get(apiUrl('/check-ins'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Something went wrong.' } },
          { status: 500 },
        ),
      ),
    );
    render(<CheckInIndexScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  });
});

describe('Check in now on the list', () => {
  beforeEach(() =>
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-16T18:00:00Z') }),
  );
  afterEach(() => vi.useRealTimers());

  const poll = () => act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
  const renderList = () =>
    render(<CheckInIndexScreen />, { advanceTimers: vi.advanceTimersByTime });
  const said = (text: string | RegExp) =>
    screen.findByText(text, { selector: '[role="status"], [role="status"] *' });

  it('runs this month’s check-in, follows the job and lists the new check-in', async () => {
    checkinDb.checkIns = [];
    scriptJob(
      checkInJobStates(checkInJobId(1), { outcome: 'created', check_in_id: NOVEMBER_ID }),
      () => (checkinDb.checkIns = [novemberCheckIn()]),
    );
    const { user } = renderList();
    await screen.findByText(/No check-in yet\./);

    await user.click(screen.getByRole('button', { name: 'Check in now' }));
    const bar = await screen.findByRole('progressbar', { name: 'Checking in' });
    expect(bar).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check in now' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await poll();
    await poll();

    expect(await said('This month’s check-in is ready.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open it' })).toHaveAttribute(
      'href',
      `/check-in/${NOVEMBER_ID}`,
    );
    const list = await screen.findByRole('list', { name: 'Check-ins' });
    expect(within(list).getByRole('link', { name: 'November 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Checking in' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check in now' })).not.toHaveAttribute('aria-busy');
  });

  it('says this month’s open check-in is up to date after it runs again', async () => {
    const { user } = renderList();
    await screen.findByRole('list', { name: 'Check-ins' });
    await user.click(screen.getByRole('button', { name: 'Check in now' }));
    expect(await said('This month’s check-in is up to date.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open it' })).toHaveAttribute(
      'href',
      `/check-in/${NOVEMBER_ID}`,
    );
  });

  it('leaves a completed month as it is, and says so', async () => {
    checkinDb.checkIns = [completedNovemberCheckIn()];
    const { user } = renderList();
    await screen.findByRole('list', { name: 'Check-ins' });
    await user.click(screen.getByRole('button', { name: 'Check in now' }));
    expect(
      await said('This month’s check-in is already complete, so nothing was changed.'),
    ).toBeInTheDocument();
  });

  it('says when the run did not finish, and Try again starts another', async () => {
    scriptJob([checkInJob(checkInJobId(1), { status: 'dead', last_error: 'boom' })]);
    const { user } = renderList();
    await screen.findByRole('list', { name: 'Check-ins' });
    await user.click(screen.getByRole('button', { name: 'Check in now' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Checking in did not finish. Nothing was changed.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await said('This month’s check-in is up to date.')).toBeInTheDocument();
    expect(checkinDb.jobs).toEqual([checkInJobId(1), checkInJobId(2)]);
  });

  it('says why a start was refused', async () => {
    server.use(
      http.post(apiUrl('/check-ins'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Something went wrong.' } },
          { status: 500 },
        ),
      ),
    );
    const { user } = renderList();
    await screen.findByRole('list', { name: 'Check-ins' });
    await user.click(screen.getByRole('button', { name: 'Check in now' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not check in now. Something went wrong.',
      ),
    );
  });
});
