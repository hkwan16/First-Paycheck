import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { checkinDb } from '@/test/msw/checkin-handlers';
import { partialBasisHoldings } from '@/test/fixtures/checkins';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { queryKeys } from '../keys';
import { useHoldings, useNetWorth } from './net-worth';

afterEach(() => server.events.removeAllListeners());

describe('useNetWorth', () => {
  it('asks for the number of months and returns the series as the API built it', async () => {
    const asked: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/net-worth') asked.push(url.search);
    });
    const { result, queryClient } = renderHookWithClient(() => useNetWorth(12));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(asked).toEqual(['?months=12']);
    expect(result.current.data?.series.map((p) => p.net_worth_cents)).toEqual([
      450_000, 465_000, 547_754,
    ]);
    expect(result.current.data?.change_cents).toBe(97_754);
    // Under the prefix a sync invalidates.
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.netWorth() }).length).toBe(1);
  });

  it('reports the API refusing a months value out of range', async () => {
    const { result } = renderHookWithClient(() => useNetWorth(61));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ error: { code: 'validation_error' } });
  });
});

describe('useHoldings', () => {
  it('returns each account’s newest holdings with a missing basis left as null', async () => {
    checkinDb.holdings = partialBasisHoldings();
    const { result } = renderHookWithClient(() => useHoldings());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.accounts.map((a) => [a.name, a.cost_basis_cents])).toEqual([
      ['Acme 401(k)', 21_668],
      ['Brokerage', null],
    ]);
    expect(result.current.data?.gain_cents).toBeNull();
  });
});
