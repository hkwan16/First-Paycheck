import { act, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleTransactions } from '@/test/fixtures/sample';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import type { Transaction } from '../types';
import { useFixCategory, useTransactions } from './transactions';

const byMerchant = (rows: readonly Transaction[] | undefined, merchant: string) =>
  rows?.filter((t) => t.merchant_clean === merchant) ?? [];

const SWEETGREEN = sampleTransactions.find((t) => t.merchant_clean === 'Sweetgreen')!;
const TRADER_JOES = sampleTransactions.filter((t) => t.merchant_clean === "Trader Joe's");

/** The query of every `GET /transactions`, as the server received it. */
function transactionReads() {
  const seen: Record<string, string>[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === '/transactions') seen.push(Object.fromEntries(url.searchParams));
  });
  return seen;
}

afterEach(() => server.events.removeAllListeners());

describe('useTransactions', () => {
  it('reads newest first and follows the cursor page by page', async () => {
    const { result } = renderHookWithClient(() => useTransactions({ limit: 10 }));
    await waitFor(() => expect(result.current.transactions).toHaveLength(10));
    expect(result.current.transactions[0]?.posted_at).toBe('2026-10-17');
    expect(result.current.hasNextPage).toBe(true);

    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.transactions).toHaveLength(16));
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.transactions.map((t) => t.id)).toEqual(
      sampleTransactions.map((t) => t.id),
    );
  });

  it('passes filters to the API', async () => {
    const { result } = renderHookWithClient(() =>
      useTransactions({ limit: 50, category: 'groceries' }),
    );
    await waitFor(() => expect(result.current.transactions).toHaveLength(2));
    expect(result.current.transactions.every((t) => t.category === 'groceries')).toBe(true);
  });

  it('keeps the period on every page it reads', async () => {
    const reads = transactionReads();
    const { result } = renderHookWithClient(() =>
      useTransactions({ limit: 5, start: '2026-10-05', end: '2026-10-13' }),
    );
    await waitFor(() => expect(result.current.transactions).toHaveLength(5));
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    // October 5, 6, 8, 9, 11, 12 and 13 have a row each.
    expect(result.current.transactions.map((t) => t.posted_at)).toEqual([
      '2026-10-13',
      '2026-10-12',
      '2026-10-11',
      '2026-10-09',
      '2026-10-08',
      '2026-10-06',
      '2026-10-05',
    ]);
    expect(reads).toEqual([
      { limit: '5', start: '2026-10-05', end: '2026-10-13' },
      { limit: '5', start: '2026-10-05', end: '2026-10-13', cursor: expect.any(String) },
    ]);
  });

  it('asks for nothing while the filters are not known', async () => {
    const reads = transactionReads();
    const { result } = renderHookWithClient(() => useTransactions(null));
    await act(() => delay(50));
    expect(reads).toEqual([]);
    expect(result.current.isPending).toBe(true);
    expect(result.current.transactions).toEqual([]);
  });

  it('keeps the last rows on screen while other filters load', async () => {
    const answer = Promise.withResolvers<void>();
    server.use(
      http.get(apiUrl('/transactions'), async ({ request }) => {
        if (new URL(request.url).searchParams.get('start') === '2026-10-02') await answer.promise;
      }),
    );
    const late = { limit: 50, start: '2026-10-02', end: '2026-10-05' };
    const { result, rerender } = renderHookWithClient(useTransactions, {
      initialProps: { limit: 50, start: '2026-10-13', end: '2026-10-17' } as typeof late | null,
    });
    await waitFor(() => expect(result.current.transactions).toHaveLength(5));

    rerender(late);
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.transactions).toHaveLength(5);
    expect(result.current.hasNextPage).toBe(false);

    answer.resolve();
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    expect(result.current.transactions.map((t) => t.posted_at)).toEqual([
      '2026-10-05',
      '2026-10-04',
      '2026-10-03',
      '2026-10-02',
    ]);
  });
});

describe('useFixCategory', () => {
  function setup(limit = 50) {
    return renderHookWithClient(() => ({
      list: useTransactions({ limit }),
      fix: useFixCategory(),
    }));
  }

  it('relabels the row and its merchant siblings at once, as the server will', async () => {
    server.use(
      http.patch(apiUrl('/transactions/:id'), async () => {
        await delay(100);
        return HttpResponse.json({ error: { code: 'x', message: 'held' } }, { status: 503 });
      }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.list.transactions).toHaveLength(16));

    act(() => result.current.fix.mutate({ transactionId: TRADER_JOES[0]!.id, category: 'dining' }));
    await waitFor(() =>
      expect(byMerchant(result.current.list.transactions, "Trader Joe's")).toEqual([
        expect.objectContaining({ category: 'dining', category_source: 'user', confidence: null }),
        expect.objectContaining({ category: 'dining', category_source: 'rule', confidence: null }),
      ]),
    );
  });

  it('keeps the fix and reports the rule the server saved', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.list.transactions).toHaveLength(16));
    act(() => result.current.fix.mutate({ transactionId: SWEETGREEN.id, category: 'groceries' }));
    await waitFor(() => expect(result.current.fix.isSuccess).toBe(true));
    expect(result.current.fix.data?.rule).toEqual({
      merchant_norm: 'sweetgreen',
      category: 'groceries',
    });
    await waitFor(() =>
      expect(byMerchant(result.current.list.transactions, 'Sweetgreen')[0]).toMatchObject({
        category: 'groceries',
        category_source: 'user',
      }),
    );
  });

  it('rolls back to the previous label when the server refuses', async () => {
    server.use(
      http.patch(apiUrl('/transactions/:id'), () =>
        HttpResponse.json(
          { error: { code: 'validation_error', message: 'No such category' } },
          { status: 422 },
        ),
      ),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.list.transactions).toHaveLength(16));
    act(() => result.current.fix.mutate({ transactionId: SWEETGREEN.id, category: 'travel' }));
    await waitFor(() => expect(result.current.fix.isError).toBe(true));
    expect(byMerchant(result.current.list.transactions, 'Sweetgreen')[0]).toMatchObject({
      category: 'dining',
      category_source: 'llm',
      confidence: 0.91,
    });
  });

  it('updates every cached page, not only the first', async () => {
    const { result } = setup(10);
    await waitFor(() => expect(result.current.list.transactions).toHaveLength(10));
    await act(() => result.current.list.fetchNextPage());
    await waitFor(() => expect(result.current.list.transactions).toHaveLength(16));
    // Trader Joe's rows sit on page 1 (Oct 17) and page 2 (Oct 2).
    act(() =>
      result.current.fix.mutate({ transactionId: TRADER_JOES[1]!.id, category: 'shopping' }),
    );
    await waitFor(() =>
      expect(
        byMerchant(result.current.list.transactions, "Trader Joe's").map((t) => t.category),
      ).toEqual(['shopping', 'shopping']),
    );
  });
});
