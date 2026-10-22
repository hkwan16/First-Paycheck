import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { CHASE_ITEM_ID } from '@/test/fixtures/sample';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import type { LinkItemRequest } from '../types';
import { useAccounts } from './accounts';
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
});
