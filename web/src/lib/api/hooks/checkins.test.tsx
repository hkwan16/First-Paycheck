import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkInJob,
  checkInJobId,
  checkInJobStates,
  NOVEMBER_ID,
  novemberCalendar,
  OCTOBER_ID,
} from '@/test/fixtures/checkins';
import { checkinDb } from '@/test/msw/checkin-handlers';
import { db } from '@/test/msw/db';
import { apiUrl, scriptJob } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { ApiError } from '../errors';
import { queryKeys } from '../keys';
import type { CheckInDetail } from '../types';
import { useCalendar } from './decisions';
import { useCheckIn, useCheckInNow, useCheckIns, useUpdateFinding } from './checkins';
import { JOB_POLL_MS } from './jobs';

/** November's 401(k) election finding. */
const electionId = 'f1000000-0000-4000-8000-000000000001';

/** PATCH bodies sent to a finding, with the path they went to. */
function patches() {
  const sent: { path: string; body: unknown }[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'PATCH') {
      sent.push({ path: new URL(request.url).pathname, body: await request.clone().json() });
    }
  });
  return sent;
}

afterEach(() => server.events.removeAllListeners());

function setup() {
  return renderHookWithClient(() => ({
    list: useCheckIns(),
    detail: useCheckIn(NOVEMBER_ID),
    update: useUpdateFinding(NOVEMBER_ID),
  }));
}

const election = (detail: CheckInDetail | undefined) =>
  detail?.findings.find((f) => f.id === electionId);

/**
 * Holds a mocked response until the test calls `open()`, so the optimistic
 * state can be checked before the server answers. A fixed delay instead races
 * the polling `waitFor` on a loaded machine and misses the window.
 */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe('useCheckIns', () => {
  it('lists check-ins newest month first with their counts', async () => {
    const { result } = renderHookWithClient(() => useCheckIns());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      result.current.data?.map((c) => [c.period, c.status, c.handled_count, c.finding_count]),
    ).toEqual([
      ['2026-11-01', 'open', 0, 9],
      ['2026-10-01', 'completed', 2, 2],
    ]);
  });
});

describe('useCheckIn', () => {
  it('reads one check-in with its findings in the API order and its cash flow against the plan', async () => {
    const { result } = renderHookWithClient(() => useCheckIn(OCTOBER_ID));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.findings.map((f) => f.kind)).toEqual([
      'election_mismatch',
      'recurring_stopped',
    ]);
  });

  it('answers another person’s check-in with not_found, without retrying', async () => {
    const { result } = renderHookWithClient(() =>
      useCheckIn('c1000000-0000-4000-8000-00000000ffff'),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('useUpdateFinding', () => {
  it('marks a finding done at once, sends only user_action, then keeps the server copy', async () => {
    const answer = gate();
    server.use(
      http.patch(apiUrl('/check-ins/:id/findings/:fid'), async ({ params }) => {
        await answer.opened;
        const checkIn = checkinDb.checkIns.find((c) => c.id === params.id)!;
        const finding = checkIn.findings.find((f) => f.id === params.fid)!;
        Object.assign(finding, { user_action: 'done', user_action_at: '2026-11-16T18:00:00Z' });
        checkIn.handled_count = 1;
        return HttpResponse.json(finding);
      }),
    );
    const sent = patches();
    const { result } = setup();
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));

    act(() => result.current.update.mutate({ findingId: electionId, type: 'done' }));
    await waitFor(() => expect(election(result.current.detail.data)?.user_action).toBe('done'));
    expect(result.current.detail.data?.handled_count).toBe(1);
    expect(result.current.update.isPending).toBe(true);

    answer.open();
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    await waitFor(() =>
      expect(election(result.current.detail.data)?.user_action_at).toBe('2026-11-16T18:00:00Z'),
    );
    expect(sent).toEqual([
      { path: `/check-ins/${NOVEMBER_ID}/findings/${electionId}`, body: { user_action: 'done' } },
    ]);
  });

  it('dismisses, and undoes with null', async () => {
    const sent = patches();
    const { result } = setup();
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));

    act(() => result.current.update.mutate({ findingId: electionId, type: 'dismiss' }));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(election(result.current.detail.data)?.user_action).toBe('dismissed');

    act(() => result.current.update.mutate({ findingId: electionId, type: 'undo' }));
    await waitFor(() => expect(election(result.current.detail.data)?.user_action).toBeNull());
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(sent.map((s) => s.body)).toEqual([{ user_action: 'dismissed' }, { user_action: null }]);
  });

  it('puts the finding back when the server refuses, and reports the reason', async () => {
    const refusal = gate();
    server.use(
      http.patch(apiUrl('/check-ins/:id/findings/:fid'), async () => {
        await refusal.opened;
        return HttpResponse.json(
          { error: { code: 'not_found', message: 'Finding not found' } },
          { status: 404 },
        );
      }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));
    const before = result.current.detail.data;

    act(() => result.current.update.mutate({ findingId: electionId, type: 'done' }));
    await waitFor(() => expect(election(result.current.detail.data)?.user_action).toBe('done'));
    refusal.open();
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect(result.current.detail.data).toEqual(before);
    expect(result.current.update.error).toMatchObject({
      status: 404,
      error: { code: 'not_found', message: 'Finding not found' },
    });
  });

  it('rolls back and reports only the refused finding when another one is in flight', async () => {
    const other = 'f1000000-0000-4000-8000-000000000002';
    const refusal = gate();
    const success = gate();
    server.use(
      http.patch(apiUrl('/check-ins/:id/findings/:fid'), async ({ params }) => {
        if (params.fid === electionId) {
          await refusal.opened;
          return HttpResponse.json(
            { error: { code: 'internal_error', message: 'Try again' } },
            { status: 500 },
          );
        }
        await success.opened;
        const finding = checkinDb.checkIns[0]!.findings.find((f) => f.id === params.fid)!;
        Object.assign(finding, { user_action: 'done', user_action_at: '2026-11-16T18:00:00Z' });
        checkinDb.checkIns[0]!.handled_count = 1;
        return HttpResponse.json(finding);
      }),
    );
    const refused: unknown[] = [];
    const { result } = renderHookWithClient(() => ({
      detail: useCheckIn(NOVEMBER_ID),
      update: useUpdateFinding(NOVEMBER_ID, {
        onError: (error, variables) => refused.push([variables.findingId, error]),
      }),
    }));
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));

    act(() => {
      result.current.update.mutate({ findingId: electionId, type: 'done' });
      result.current.update.mutate({ findingId: other, type: 'done' });
    });
    await waitFor(() => expect(result.current.detail.data?.handled_count).toBe(2));
    // The refusal comes back while the other change is still in flight.
    refusal.open();
    await waitFor(() => expect(election(result.current.detail.data)?.user_action).toBeNull());
    const second = result.current.detail.data?.findings.find((f) => f.id === other);
    expect(second?.user_action).toBe('done');
    expect(result.current.detail.data?.handled_count).toBe(1);
    // The earlier, refused change is reported even though a later one was made.
    expect(refused).toMatchObject([
      [electionId, { status: 500, error: { code: 'internal_error', message: 'Try again' } }],
    ]);
    success.open();
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
  });

  it('refreshes that check-in and the list once the server answers', async () => {
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));
    // Another check-in in the cache is left alone.
    queryClient.setQueryData(queryKeys.checkIn(OCTOBER_ID), checkinDb.checkIns[1]);

    act(() => result.current.update.mutate({ findingId: electionId, type: 'done' }));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    await waitFor(() =>
      expect(result.current.list.data?.find((c) => c.id === NOVEMBER_ID)?.handled_count).toBe(1),
    );
    expect(queryClient.getQueryState(queryKeys.checkIn(OCTOBER_ID))?.isInvalidated).toBe(false);
  });
});

describe('useCalendar with a window', () => {
  it('asks for due dates within from and to', async () => {
    db.calendar = novemberCalendar();
    const asked: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname === '/calendar') asked.push(new URL(request.url).search);
    });
    const { result } = renderHookWithClient(() =>
      useCalendar({ from: '2026-11-01', to: '2026-11-30' }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((e) => e.due_at)).toEqual(['2026-11-20', '2026-11-30']);
    expect(asked).toEqual(['?from=2026-11-01&to=2026-11-30']);
  });

  it('shares the unbounded read with screens that ask for every event', async () => {
    db.calendar = novemberCalendar();
    const { result, queryClient } = renderHookWithClient(() => useCalendar());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(3);
    expect(queryClient.getQueryData(queryKeys.calendar())).toHaveLength(3);
  });
});

describe('useCheckInNow', () => {
  beforeEach(() =>
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-16T18:00:00Z') }),
  );
  afterEach(() => vi.useRealTimers());

  /** `METHOD /path` of every request, in order. */
  function requests() {
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
    });
    return seen;
  }

  function setupNow() {
    return renderHookWithClient(() => ({
      list: useCheckIns(),
      detail: useCheckIn(NOVEMBER_ID),
      now: useCheckInNow(),
    }));
  }

  it('does nothing until started', async () => {
    const { result } = renderHookWithClient(() => useCheckInNow());
    const seen = requests();
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2));
    expect(result.current.jobId).toBeNull();
    expect(result.current.outcome).toBeNull();
    expect(seen).toEqual([]);
  });

  it('queues the month’s run, follows its job, then reads the list and the check-in again', async () => {
    const id = checkInJobId(1);
    scriptJob(checkInJobStates(id));
    const { result } = setupNow();
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    const seen = requests();

    act(() => result.current.now.start());
    await waitFor(() => expect(result.current.now.jobId).toBe(id));
    // The 202 names the month's check-in when it already exists.
    expect(result.current.now.checkInId).toBe(NOVEMBER_ID);
    await waitFor(() => expect(result.current.now.job.data?.status).toBe('queued'));
    expect(result.current.now.outcome).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.now.job.data?.status).toBe('running'));
    expect(seen).not.toContain('GET /check-ins');

    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.now.outcome).toBe('refreshed'));
    expect(result.current.now.checkInId).toBe(NOVEMBER_ID);
    await waitFor(() => expect(seen).toContain('GET /check-ins'));
    await waitFor(() => expect(seen).toContain(`GET /check-ins/${NOVEMBER_ID}`));
    expect(seen[0]).toBe('POST /check-ins');
  });

  it('takes the new check-in’s id from the job when the month had none', async () => {
    checkinDb.checkIns = [];
    const { result } = setupNow();
    act(() => result.current.now.start());
    await waitFor(() => expect(result.current.now.outcome).toBe('created'));
    expect(result.current.now.checkInId).toBe(NOVEMBER_ID);
    await waitFor(() => expect(result.current.list.data?.map((c) => c.id)).toEqual([NOVEMBER_ID]));
  });

  it('reports a dead run as failed, and a new start queues a new job', async () => {
    scriptJob([checkInJob(checkInJobId(1), { status: 'dead', last_error: 'boom' })]);
    const { result } = renderHookWithClient(() => useCheckInNow());

    act(() => result.current.start());
    await waitFor(() => expect(result.current.job.isFailed).toBe(true));
    expect(result.current.outcome).toBeNull();

    act(() => result.current.start());
    await waitFor(() => expect(result.current.jobId).toBe(checkInJobId(2)));
    await waitFor(() => expect(result.current.outcome).toBe('refreshed'));
    expect(result.current.job.isFailed).toBe(false);
  });

  it('reports a refused start, a 429 with its wait', async () => {
    server.use(
      http.post(apiUrl('/check-ins'), () =>
        HttpResponse.json(
          { error: { code: 'rate_limited', message: 'Too many requests' } },
          { status: 429, headers: { 'Retry-After': '1200' } },
        ),
      ),
    );
    const { result } = renderHookWithClient(() => useCheckInNow());
    act(() => result.current.start());
    await waitFor(() => expect(result.current.startError).toBeInstanceOf(ApiError));
    expect(result.current.startError).toMatchObject({ status: 429, retryAfterSeconds: 1200 });
    expect(result.current.jobId).toBeNull();
  });
});
