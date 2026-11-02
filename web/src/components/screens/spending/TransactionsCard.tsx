'use client';

import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorMessage } from '@/lib/api/errors';
import { useAccounts, useFixCategory, useTransactions } from '@/lib/api/hooks';
import type { TransactionFilters } from '@/lib/api/keys';
import type { Category, Transaction } from '@/lib/api/types';
import { categoryInfo } from '@/lib/categories';
import { formatNumber } from '@/lib/money';
import { periodText } from './spending-format';
import { TransactionTable } from './TransactionTable';

type FixResult =
  | { kind: 'saved'; merchant: string; category: string; relabeled: number }
  | { kind: 'failed'; merchant: string; previous: string; message: string };

function FixNotice({ result }: { result: FixResult }) {
  if (result.kind === 'failed') {
    return (
      <Notice tone="warning" compact role="alert">
        Could not save the category for {result.merchant}. It is back to {result.previous}.{' '}
        {result.message}
      </Notice>
    );
  }
  const earlier =
    result.relabeled === 0
      ? ''
      : `, and ${formatNumber(result.relabeled)} earlier ${
          result.relabeled === 1 ? 'transaction' : 'transactions'
        } changed too`;
  return (
    <Notice tone="confirmed" compact role="status">
      Saved. {result.merchant} will be {result.category} from now on{earlier}.
    </Notice>
  );
}

/** How many rows the card shows before "Show all transactions" (issue 201). */
export const PREVIEW_ROWS = 10;

function LoadingRows() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4 py-2">
      <span className="sr-only">Loading your transactions</span>
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} block className="h-6 w-full" />
      ))}
    </div>
  );
}

export interface TransactionsCardProps {
  /**
   * The list to read (spec 003 rule 17a): the summary's period
   * (`periodFilters`), or the newest rows when the period cannot be known;
   * null while it is not known yet.
   */
  filters: TransactionFilters | null;
}

/**
 * The mockup's transactions card: the period's table, where each category
 * came from, and the category fix. A fix shows at once (useFixCategory is
 * optimistic); the notice says it was saved for the merchant from now on, or
 * that it went back. While
 * another period loads, the last rows stay on screen and the card is busy.
 */
export function TransactionsCard({ filters }: TransactionsCardProps) {
  const list = useTransactions(filters);
  const accounts = useAccounts().data;
  const fix = useFixCategory();
  const [result, setResult] = useState<FixResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const tableId = useId();

  const masks = useMemo(
    () => new Map((accounts ?? []).map((a) => [a.id, a.mask] as const)),
    [accounts],
  );

  const onCategoryChange = (txn: Transaction, category: Category) => {
    const merchant = txn.merchant_clean ?? txn.merchant_raw;
    const previous = txn.category ? categoryInfo(txn.category).label : 'no category';
    setResult(null);
    fix.mutate(
      { transactionId: txn.id, category },
      {
        onSuccess: (saved) =>
          setResult(
            saved.rule
              ? {
                  kind: 'saved',
                  merchant,
                  category: categoryInfo(category).label,
                  relabeled: saved.relabeled,
                }
              : null,
          ),
        onError: (error) =>
          setResult({
            kind: 'failed',
            merchant,
            previous,
            message: apiErrorMessage(error, 'Check your connection and try again.'),
          }),
      },
    );
  };

  let body;
  if (list.isPending) {
    body = <LoadingRows />;
  } else if (list.isError) {
    body = (
      <Notice tone="warning" compact role="alert" className="items-center">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            Could not load your transactions.{' '}
            {apiErrorMessage(list.error, 'Check your connection.')}
          </span>
          <Button size="sm" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      </Notice>
    );
  } else if (list.transactions.length === 0) {
    body =
      filters?.start && filters.end && accounts?.length !== 0 ? (
        <p className="m-0 text-small text-ink-3">
          No transactions from {periodText(filters.start, filters.end)}. Pick another period above.
        </p>
      ) : (
        <p className="m-0 text-small text-ink-3">
          No transactions yet. <Link href="/setup/link">Link a bank</Link> and they show up here
          once it syncs.
        </p>
      );
  } else {
    const more = list.transactions.length > PREVIEW_ROWS || list.hasNextPage;
    body = (
      <>
        <TransactionTable
          id={tableId}
          transactions={expanded ? list.transactions : list.transactions.slice(0, PREVIEW_ROWS)}
          masks={masks}
          onCategoryChange={onCategoryChange}
        />
        {more && (
          <div>
            <Button
              aria-expanded={expanded}
              aria-controls={tableId}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Show fewer' : 'Show all transactions'}
            </Button>
          </div>
        )}
        {expanded && list.hasNextPage && (
          <div>
            <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
              Load more transactions
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <Card aria-labelledby="txn-title" gap={12} aria-busy={list.isPlaceholderData || undefined}>
      <h2 id="txn-title" className="m-0">
        Transactions
      </h2>
      {result && <FixNotice result={result} />}
      {body}
    </Card>
  );
}
