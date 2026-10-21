import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchClient } from '../client';
import { invalidateSpending, queryKeys, type TransactionFilters } from '../keys';
import type { Category, Transaction, TransactionPage } from '../types';
import { unwrap } from './request';

/**
 * `GET /transactions` page by page (newest first), following `next_cursor`.
 * Returns the loaded rows flattened, plus the paging controls.
 */
export function useTransactions(filters: TransactionFilters) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.transactionPages(filters),
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        fetchClient.GET('/transactions', {
          params: { query: pageParam ? { ...filters, cursor: pageParam } : filters },
          signal,
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: TransactionPage) => last.next_cursor,
  });
  const transactions = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  return {
    transactions,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

export interface FixCategoryVariables {
  transactionId: string;
  category: Category;
}

type TransactionsCache = InfiniteData<TransactionPage, string | null> | TransactionPage;

/** Apply `relabel` to every row in a cached transactions read, paged or not. */
function mapCache(cache: TransactionsCache | undefined, relabel: (t: Transaction) => Transaction) {
  if (!cache) return cache;
  if ('pages' in cache) {
    return {
      ...cache,
      pages: cache.pages.map((page) => ({ ...page, items: page.items.map(relabel) })),
    };
  }
  return { ...cache, items: cache.items.map(relabel) };
}

function findTransaction(caches: [QueryKey, TransactionsCache | undefined][], id: string) {
  for (const [, cache] of caches) {
    const pages = cache && ('pages' in cache ? cache.pages : [cache]);
    for (const page of pages ?? []) {
      const found = page.items.find((t) => t.id === id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * `PATCH /transactions/{id}`: the user's category becomes a rule for the
 * merchant. Every cached transactions read shows the result at once, as the
 * server will write it: the row becomes the user's label, and the merchant's
 * other rows not labeled individually follow as rule labels. On failure every
 * cache goes back; either way the reads and totals refetch afterwards.
 */
export function useFixCategory() {
  const queryClient = useQueryClient();
  const prefix = { queryKey: queryKeys.transactions() };
  return useMutation({
    mutationFn: ({ transactionId, category }: FixCategoryVariables) =>
      unwrap(
        fetchClient.PATCH('/transactions/{transaction_id}', {
          params: { path: { transaction_id: transactionId } },
          body: { category },
        }),
      ),
    onMutate: async ({ transactionId, category }) => {
      await queryClient.cancelQueries(prefix);
      const snapshot = queryClient.getQueriesData<TransactionsCache>(prefix);
      const target = findTransaction(snapshot, transactionId);
      const relabel = (t: Transaction): Transaction => {
        if (t.id === transactionId) {
          return { ...t, category, category_source: 'user', confidence: null };
        }
        if (target?.merchant_norm && t.merchant_norm === target.merchant_norm) {
          if (t.category_source === 'user') return t;
          return { ...t, category, category_source: 'rule', confidence: null };
        }
        return t;
      };
      queryClient.setQueriesData<TransactionsCache>(prefix, (cache) => mapCache(cache, relabel));
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: () => invalidateSpending(queryClient),
  });
}
