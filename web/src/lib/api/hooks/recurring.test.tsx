import { act, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleRecurring } from '@/test/fixtures/cashflow';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { spendingDb } from '@/test/msw/spending-handlers';
import { renderHookWithClient } from '@/test/render';
import type { RecurringCharge } from '../types';
import { useRecurring, useUpdateRecurring } from './recurring';

const SPOTIFY = sampleRecurring[3]!;

const find = (charges: RecurringCharge[] | undefined, id: string) =>
  charges?.find((c) => c.id === id);

function setup() {
  return renderHookWithClient(() => ({ list: useRecurring(), update: useUpdateRecurring() }));
}

/** PATCH bodies sent to `/recurring/{id}`. */
function patches() {
  const bodies: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'PATCH' && new URL(request.url).pathname.startsWith('/recurring/')) {
      bodies.push(await request.clone().json());
    }
  });
  return bodies;
}

afterEach(() => server.events.removeAllListeners());

describe('useRecurring', () => {
  it("lists the person's recurring charges in the API's order", async () => {
    const { result } = renderHookWithClient(() => useRecurring());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((c) => c.merchant_clean)).toEqual([
      'Hulu',
      'Lemonade Renters',
      'Parkline Apartments',
      'Spotify',
      'Verizon Wireless',
    ]);
  });
});

describe('useUpdateRecurring', () => {
  it('marks a charge not recurring at once, sends only that field, then keeps the server copy', async () => {
    server.use(
      http.patch(apiUrl('/recurring/:id'), async ({ params, request }) => {
        await delay(200);
        const charge = spendingDb.recurring.find((c) => c.id === params.id)!;
        Object.assign(charge, await request.json(), { updated_at: '2026-10-17T16:01:00Z' });
        return HttpResponse.json(charge);
      }),
    );
    const sent = patches();
    const { result } = setup();
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    act(() =>
      result.current.update.mutate({ chargeId: SPOTIFY.id, patch: { user_status: 'ignored' } }),
    );
    await waitFor(() =>
      expect(find(result.current.list.data, SPOTIFY.id)?.user_status).toBe('ignored'),
    );
    expect(result.current.update.isPending).toBe(true);

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    await waitFor(() =>
      expect(find(result.current.list.data, SPOTIFY.id)?.updated_at).toBe('2026-10-17T16:01:00Z'),
    );
    expect(sent).toEqual([{ user_status: 'ignored' }]);
  });

  it('shows a rename trimmed, as the server will store it', async () => {
    server.use(
      http.patch(apiUrl('/recurring/:id'), async () => {
        await delay(200);
        return HttpResponse.json({ ...SPOTIFY, merchant_clean: 'Spotify Family' });
      }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    act(() =>
      result.current.update.mutate({
        chargeId: SPOTIFY.id,
        patch: { merchant_clean: '  Spotify Family ' },
      }),
    );
    await waitFor(() =>
      expect(find(result.current.list.data, SPOTIFY.id)?.merchant_clean).toBe('Spotify Family'),
    );
    expect(result.current.update.isPending).toBe(true);
  });

  it('puts the charge back when the server refuses, and reports the reason', async () => {
    server.use(
      http.patch(apiUrl('/recurring/:id'), async () => {
        await delay(200);
        return HttpResponse.json(
          { error: { code: 'validation_error', message: 'merchant_clean is too long' } },
          { status: 422 },
        );
      }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    act(() =>
      result.current.update.mutate({ chargeId: SPOTIFY.id, patch: { merchant_clean: 'x' } }),
    );
    await waitFor(() =>
      expect(find(result.current.list.data, SPOTIFY.id)?.merchant_clean).toBe('x'),
    );
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect(find(result.current.list.data, SPOTIFY.id)).toEqual(SPOTIFY);
    expect(result.current.update.error).toEqual({
      error: { code: 'validation_error', message: 'merchant_clean is too long' },
    });
  });

  it('can restore a charge by clearing user_status', async () => {
    spendingDb.recurring[3] = { ...SPOTIFY, user_status: 'ignored' };
    const sent = patches();
    const { result } = setup();
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    act(() => result.current.update.mutate({ chargeId: SPOTIFY.id, patch: { user_status: null } }));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(find(result.current.list.data, SPOTIFY.id)?.user_status).toBeNull();
    expect(sent).toEqual([{ user_status: null }]);
  });
});
