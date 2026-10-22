import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { K401MatchInput } from '@/lib/api/types';
import {
  DECISION_V1_ID,
  sampleCalendarEvent,
  sampleDecision,
  sampleK401,
  sampleK401Inputs,
} from '@/test/fixtures/decisions';
import { sampleEmergencyFund, sampleHealthPlans } from '@/test/fixtures/planning';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { sampleW4 } from '@/test/fixtures/w4';
import { db, savedDecision } from '@/test/msw/db';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { CALC_DEBOUNCE_MS, useCalc } from './calc';
import {
  ResultMismatch,
  useCalendar,
  useDecision,
  useDecisions,
  useSaveDecision,
} from './decisions';

/** Each `POST /decisions` body, in order. */
function saveBodies() {
  const bodies: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/decisions') {
      bodies.push(await request.clone().json());
    }
  });
  return bodies;
}

function countCalcRequests(path = '/calc/401k-match') {
  const seen = { count: 0 };
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname === path) seen.count += 1;
  });
  return seen;
}

afterEach(() => server.events.removeAllListeners());

describe('useDecisions', () => {
  it('is an empty list for someone who has saved nothing', async () => {
    const { result } = renderHookWithClient(() => useDecisions());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ items: [] });
  });

  it("lists each calculator's current decision and its versions", async () => {
    savedDecision();
    const { result } = renderHookWithClient(() => useDecisions());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items).toEqual([
      {
        calculator: 'k401_match',
        current: sampleDecision(),
        versions: [
          {
            id: DECISION_V1_ID,
            version: 1,
            supersedes_id: null,
            created_at: sampleDecision().created_at,
          },
        ],
      },
    ]);
  });
});

describe('useDecision', () => {
  it('reads one version', async () => {
    savedDecision();
    const { result } = renderHookWithClient(() => useDecision(DECISION_V1_ID));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleDecision());
  });

  it('answers a missing (or another person’s) decision with not_found, without retrying', async () => {
    const { result } = renderHookWithClient(() =>
      useDecision('dec00000-0000-4000-8000-00000000ffff'),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('useCalendar', () => {
  it('lists upcoming events, soonest first', async () => {
    savedDecision();
    db.calendar.push(
      sampleCalendarEvent({ id: 'ca000000-0000-4000-8000-000000000002', due_at: '2026-10-20' }),
      sampleCalendarEvent({ id: 'ca000000-0000-4000-8000-000000000003', status: 'dismissed' }),
    );
    const { result } = renderHookWithClient(() => useCalendar());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((e) => e.due_at)).toEqual(['2026-10-20', '2026-10-31']);
  });
});

describe('useSaveDecision', () => {
  it('saves version 1 with nothing to supersede, then refreshes decisions and the calendar', async () => {
    const bodies = saveBodies();
    const { result } = renderHookWithClient(() => ({
      decisions: useDecisions(),
      calendar: useCalendar(),
      save: useSaveDecision('k401_match'),
    }));
    await waitFor(() => expect(result.current.decisions.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.calendar.isSuccess).toBe(true));
    expect(result.current.calendar.data).toEqual([]);

    const { inputs, result: computed } = sampleK401(4);
    act(() => result.current.save.mutate({ inputs, result: computed, current: undefined }));
    await waitFor(() => expect(result.current.save.isSuccess).toBe(true));

    expect(bodies).toEqual([
      { calculator: 'k401_match', inputs, result: computed, supersedes_id: null },
    ]);
    expect(result.current.save.data).toMatchObject({ version: 1, supersedes_id: null });
    // The refreshed reads are in place by the time the save reports success.
    expect(result.current.decisions.data?.items[0]?.current).toMatchObject({
      version: 1,
      inputs,
      created_at: SAMPLE_NOW,
    });
    expect(result.current.calendar.data).toHaveLength(1);
  });

  it('saves the next version over the current one with supersedes_id', async () => {
    savedDecision();
    const bodies = saveBodies();
    const { result } = renderHookWithClient(() => ({
      decisions: useDecisions(),
      save: useSaveDecision('k401_match'),
    }));
    await waitFor(() => expect(result.current.decisions.isSuccess).toBe(true));
    const current = result.current.decisions.data?.items[0]?.current;

    const { inputs, result: computed } = sampleK401(6);
    act(() => result.current.save.mutate({ inputs, result: computed, current }));
    await waitFor(() => expect(result.current.save.isSuccess).toBe(true));

    expect(bodies).toEqual([expect.objectContaining({ supersedes_id: DECISION_V1_ID })]);
    const item = result.current.decisions.data?.items[0];
    expect(item?.current).toMatchObject({ version: 2, supersedes_id: DECISION_V1_ID });
    expect(item?.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('reports 409 decision_conflict and reloads the decisions when another save got there first', async () => {
    savedDecision();
    const { result } = renderHookWithClient(() => ({
      decisions: useDecisions(),
      save: useSaveDecision('k401_match'),
    }));
    await waitFor(() => expect(result.current.decisions.isSuccess).toBe(true));
    const stale = result.current.decisions.data?.items[0]?.current;
    // Another tab saves v2 over v1 after this one loaded.
    db.decisions.push(
      sampleDecision({
        id: 'dec00000-0000-4000-8000-0000000000b2',
        version: 2,
        supersedes_id: DECISION_V1_ID,
      }),
    );

    const { inputs, result: computed } = sampleK401(6);
    act(() => result.current.save.mutate({ inputs, result: computed, current: stale }));
    await waitFor(() => expect(result.current.save.isError).toBe(true));
    expect(result.current.save.error).toMatchObject({ error: { code: 'decision_conflict' } });
    await waitFor(() => expect(result.current.decisions.data?.items[0]?.current.version).toBe(2));
  });

  describe('when the result differs from the calculator’s', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it('throws ResultMismatch with the fields and recalculates', async () => {
      const calcRequests = countCalcRequests();
      const inputs: K401MatchInput = sampleK401Inputs(4);
      const { result } = renderHookWithClient(() => ({
        calc: useCalc('/calc/401k-match', inputs),
        save: useSaveDecision('k401_match'),
      }));
      await waitFor(() => expect(result.current.calc.isCurrent).toBe(true));
      expect(calcRequests.count).toBe(1);

      const stale = { ...sampleK401(4).result, missed_cents: 1 };
      act(() => result.current.save.mutate({ inputs, result: stale, current: undefined }));
      await waitFor(() => expect(result.current.save.isError).toBe(true));

      const error = result.current.save.error;
      expect(error).toBeInstanceOf(ResultMismatch);
      expect((error as ResultMismatch).fields).toEqual(['missed_cents']);
      expect(error).toMatchObject({ error: { code: 'result_mismatch' } });
      await act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));
      await waitFor(() => expect(calcRequests.count).toBe(2));
      expect(db.decisions).toEqual([]);
    });

    it.each([
      ['emergency_fund', '/calc/emergency-fund', sampleEmergencyFund()],
      ['health_plans', '/calc/health-plans', sampleHealthPlans({ selected_plan_index: 0 })],
      ['w4', '/calc/w4', sampleW4()],
    ] as const)('recalculates %s results from %s', async (calculator, path, known) => {
      const calcRequests = countCalcRequests(path);
      const { result } = renderHookWithClient(() => ({
        calc: useCalc(path, known.inputs),
        save: useSaveDecision(calculator),
      }));
      await waitFor(() => expect(result.current.calc.isCurrent).toBe(true));

      const stale = {
        ...known.result,
        recommended_index: 9,
        target_cents: 1,
        withholding_per_paycheck_cents: 1,
      };
      act(() =>
        result.current.save.mutate({ inputs: known.inputs, result: stale, current: undefined }),
      );
      await waitFor(() => expect(result.current.save.isError).toBe(true));
      expect(result.current.save.error).toBeInstanceOf(ResultMismatch);
      await act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));
      await waitFor(() => expect(calcRequests.count).toBe(2));
    });
  });

  it('saves a W-4 decision with its reminder to hand the form to the employer', async () => {
    const { result } = renderHookWithClient(() => ({
      calendar: useCalendar(),
      save: useSaveDecision('w4'),
    }));
    await waitFor(() => expect(result.current.calendar.isSuccess).toBe(true));
    const { inputs, result: computed } = sampleW4();
    act(() => result.current.save.mutate({ inputs, result: computed, current: undefined }));
    await waitFor(() => expect(result.current.save.isSuccess).toBe(true));
    expect(result.current.save.data).toMatchObject({ calculator: 'w4', version: 1, goal_id: null });
    expect(result.current.calendar.data).toEqual([
      expect.objectContaining({
        id: result.current.save.data?.calendar_event_id,
        kind: 'w4_submit',
        title: 'Give your employer your updated Form W-4',
        due_at: '2026-10-31',
        decision_id: result.current.save.data?.decision_id,
      }),
    ]);
  });

  it('refuses a health plan decision with no plan chosen, saving nothing', async () => {
    const { inputs, result: computed } = sampleHealthPlans();
    const { result } = renderHookWithClient(() => useSaveDecision('health_plans'));
    act(() => result.current.mutate({ inputs, result: computed, current: undefined }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ error: { code: 'plan_not_selected' } });
    expect(db.decisions).toEqual([]);
  });
});
