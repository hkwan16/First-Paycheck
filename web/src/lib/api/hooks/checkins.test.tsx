import { act, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { NOVEMBER_ID, novemberCalendar, OCTOBER_ID } from '@/test/fixtures/checkins';
import { checkinDb } from '@/test/msw/checkin-handlers';
import { db } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { queryKeys } from '../keys';
import type { CheckInDetail } from '../types';
import { useCalendar } from './decisions';
import { useCheckIn, useCheckIns, useUpdateFinding } from './checkins';

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
    server.use(
      http.patch(apiUrl('/check-ins/:id/findings/:fid'), async ({ params }) => {
        await delay(200);
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
    server.use(
      http.patch(apiUrl('/check-ins/:id/findings/:fid'), async () => {
        await delay(200);
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
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect(result.current.detail.data).toEqual(before);
    expect(result.current.update.error).toEqual({
      error: { code: 'not_found', message: 'Finding not found' },
    });
  });

  it('rolls back only the refused finding when another one is in flight', async () => {
    const other = 'f1000000-0000-4000-8000-000000000002';
    server.use(
      http.patch(apiUrl('/check-ins/:id/findings/:fid'), async ({ params }) => {
        await delay(100);
        if (params.fid === electionId) {
          return HttpResponse.json(
            { error: { code: 'internal_error', message: 'Try again' } },
            { status: 500 },
          );
        }
        await delay(200);
        const finding = checkinDb.checkIns[0]!.findings.find((f) => f.id === params.fid)!;
        Object.assign(finding, { user_action: 'done', user_action_at: '2026-11-16T18:00:00Z' });
        checkinDb.checkIns[0]!.handled_count = 1;
        return HttpResponse.json(finding);
      }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));

    act(() => {
      result.current.update.mutate({ findingId: electionId, type: 'done' });
      result.current.update.mutate({ findingId: other, type: 'done' });
    });
    await waitFor(() => expect(result.current.detail.data?.handled_count).toBe(2));
    await waitFor(() => expect(election(result.current.detail.data)?.user_action).toBeNull());
    const second = result.current.detail.data?.findings.find((f) => f.id === other);
    expect(second?.user_action).toBe('done');
    expect(result.current.detail.data?.handled_count).toBe(1);
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
