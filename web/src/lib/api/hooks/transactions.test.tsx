import { act, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
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
