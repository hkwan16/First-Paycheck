import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHASE_ITEM_ID, SAMPLE_NOW } from '@/test/fixtures/sample';
import { apiUrl, recurringJobId, recurringJobStates, scriptJob } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import type { LinkItemRequest } from '../types';
import { useAccounts } from './accounts';
import { useCheckIns } from './checkins';
import { JOB_POLL_MS } from './jobs';
import { useRecurring } from './recurring';
import {
  SANDBOX_INSTITUTION_ID,
  useCreateSyncItem,
  useLinkToken,
  useSandboxLink,
  useTriggerSync,
  useUnlinkItem,
} from './sync';

function captureLinkBodies() {
  const bodies: LinkItemRequest[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/sync/items') {
      bodies.push((await request.clone().json()) as LinkItemRequest);
    }
  });
  return bodies;
}

describe('useLinkToken', () => {
  it('asks the API for a Plaid Link token', async () => {
    const { result } = renderHookWithClient(() => useLinkToken());
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.data?.link_token).toBe('link-sandbox-test'));
  });

  it("surfaces Plaid's outage as the API's error", async () => {
    server.use(
      http.post(apiUrl('/sync/link-token'), () =>
        HttpResponse.json(
          {
            error: {
              code: 'plaid_unavailable',
              message: 'Plaid is unavailable; try again shortly',
            },
          },
          { status: 503 },
        ),
      ),
    );
    const { result } = renderHookWithClient(() => useLinkToken());
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({
      status: 503,
      error: { code: 'plaid_unavailable', message: 'Plaid is unavailable; try again shortly' },
    });
  });
});

describe('linking an institution', () => {
  it('exchanges the public token and returns the sync job', async () => {
    const bodies = captureLinkBodies();
    const { result } = renderHookWithClient(() => useCreateSyncItem());
    act(() => result.current.mutate({ publicToken: 'public-xyz', institutionName: 'Chase' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.job_id).toMatch(/^5a000000-/);
    expect(bodies).toEqual([{ public_token: 'public-xyz', institution_name: 'Chase' }]);
    server.events.removeAllListeners();
  });

  it('links the sandbox institution without Plaid Link', async () => {
    const bodies = captureLinkBodies();
    const { result } = renderHookWithClient(() => useSandboxLink());
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(bodies).toEqual([{ sandbox_institution_id: SANDBOX_INSTITUTION_ID }]);
    expect(SANDBOX_INSTITUTION_ID).toBe('ins_109508');
    server.events.removeAllListeners();
  });
});

describe('useTriggerSync', () => {
  it('queues a sync for one institution', async () => {
    const { result } = renderHookWithClient(() => useTriggerSync());
    act(() => result.current.mutate(CHASE_ITEM_ID));
    await waitFor(() => expect(result.current.data?.job_id).toMatch(/^5a000000-/));
  });
});

describe('useUnlinkItem', () => {
  it('deletes the institution and refreshes the accounts it owned', async () => {
    const { result } = renderHookWithClient(() => ({
      accounts: useAccounts(),
      unlink: useUnlinkItem(),
    }));
    await waitFor(() => expect(result.current.accounts.data).toHaveLength(2));
    act(() => result.current.unlink.mutate(CHASE_ITEM_ID));
    await waitFor(() => expect(result.current.unlink.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.accounts.data).toEqual([]));
  });

  describe('following the recurring detection it queued', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
    afterEach(() => {
      vi.useRealTimers();
      server.events.removeAllListeners();
    });

    function countReads(path: string) {
      const reads = { count: 0 };
      server.events.on('request:start', ({ request }) => {
        if (request.method === 'GET' && new URL(request.url).pathname === path) reads.count += 1;
      });
      return reads;
    }

    it('reads recurring charges and check-ins again once the job ends, not before', async () => {
      const jobId = scriptJob(recurringJobStates(recurringJobId(1)));
      const recurring = countReads('/recurring');
      const checkIns = countReads('/check-ins');
      const { result } = renderHookWithClient(() => ({
        recurring: useRecurring(),
        checkIns: useCheckIns(),
        unlink: useUnlinkItem(),
      }));
      await waitFor(() => expect(result.current.recurring.isSuccess).toBe(true));
      await waitFor(() => expect(result.current.checkIns.isSuccess).toBe(true));
      expect([recurring.count, checkIns.count]).toEqual([1, 1]);

      act(() => result.current.unlink.mutate(CHASE_ITEM_ID));
      await waitFor(() => expect(result.current.unlink.recurringJob.data?.status).toBe('queued'));
      expect(result.current.unlink.recurringJob.data?.id).toBe(jobId);
      // A check-in's cash flow changes with the unlink itself; the charges wait for the job.
      await waitFor(() => expect(checkIns.count).toBe(2));
      expect(recurring.count).toBe(1);

      await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
      expect(result.current.unlink.recurringJob.data?.status).toBe('running');
      expect(recurring.count).toBe(1);

      await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
      expect(result.current.unlink.recurringJob.isTerminal).toBe(true);
      await waitFor(() => expect(recurring.count).toBe(2));
      await waitFor(() => expect(checkIns.count).toBe(3));
    });

    it('follows nothing before an unlink', () => {
      const { result } = renderHookWithClient(() => useUnlinkItem());
      expect(result.current.recurringJob.data).toBeUndefined();
      expect(result.current.recurringJob.isTerminal).toBe(false);
    });
  });
});
