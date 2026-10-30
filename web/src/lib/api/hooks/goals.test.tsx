import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GOAL_ID, sampleGoal } from '@/test/fixtures/planning';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { planningDb, savedEmergencyFund } from '@/test/msw/planning-handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { queryKeys } from '../keys';
import { useGoals, useUpdateGoal } from './goals';

/** Each `PATCH /goals/{id}` body, in order. */
function patchBodies() {
  const bodies: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'PATCH' && new URL(request.url).pathname.startsWith('/goals/')) {
      bodies.push(await request.clone().json());
    }
  });
  return bodies;
}

afterEach(() => server.events.removeAllListeners());

describe('useGoals', () => {
  it('is empty before any emergency fund decision', async () => {
    const { result } = renderHookWithClient(() => useGoals());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('lists the goal a saved emergency fund decision made', async () => {
    savedEmergencyFund();
    const { result } = renderHookWithClient(() => useGoals());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([sampleGoal()]);
  });
});

describe('useUpdateGoal', () => {
  it('reads the plan again, which shows the goal', async () => {
    savedEmergencyFund();
    const { result, queryClient } = renderHookWithClient(() => useUpdateGoal());
    queryClient.setQueryData(queryKeys.plan(), {});
    act(() => result.current.mutate({ goalId: GOAL_ID, patch: { status: 'paused' } }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() =>
      expect(queryClient.getQueryState(queryKeys.plan())?.isInvalidated).toBe(true),
    );
  });

  it('sends only what changed and puts the goal the server returns in the list', async () => {
    savedEmergencyFund();
    const bodies = patchBodies();
    const { result, queryClient } = renderHookWithClient(() => ({
      goals: useGoals(),
      update: useUpdateGoal(),
    }));
    await waitFor(() => expect(result.current.goals.isSuccess).toBe(true));

    act(() => result.current.update.mutate({ goalId: GOAL_ID, patch: { status: 'paused' } }));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(bodies).toEqual([{ status: 'paused' }]);
    expect(result.current.goals.data?.[0]).toMatchObject({ status: 'paused', reached_at: null });
    expect(queryClient.getQueryData(queryKeys.goals())).toEqual(planningDb.goals);
  });

  it('marks a goal reached, and a changed contribution projects the date again', async () => {
    savedEmergencyFund();
    const { result } = renderHookWithClient(() => ({
      goals: useGoals(),
      update: useUpdateGoal(),
    }));
    await waitFor(() => expect(result.current.goals.isSuccess).toBe(true));

    act(() =>
      result.current.update.mutate({
        goalId: GOAL_ID,
        patch: { monthly_contribution_cents: 50_000 },
      }),
    );
    await waitFor(() =>
      expect(result.current.goals.data?.[0]).toMatchObject({
        monthly_contribution_cents: 50_000,
        target_date: '2027-04-30',
      }),
    );

    act(() => result.current.update.mutate({ goalId: GOAL_ID, patch: { status: 'reached' } }));
    await waitFor(() =>
      expect(result.current.goals.data?.[0]).toMatchObject({
        status: 'reached',
        reached_at: SAMPLE_NOW,
      }),
    );
  });

  it("reports the API's 404 for a goal that is gone", async () => {
    const { result } = renderHookWithClient(() => useUpdateGoal());
    act(() => result.current.mutate({ goalId: GOAL_ID, patch: { status: 'paused' } }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ error: { code: 'not_found' } });
  });
});
