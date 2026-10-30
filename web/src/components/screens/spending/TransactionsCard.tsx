'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorMessage } from '@/lib/api/errors';
import {
  periodFilters,
  TRANSACTIONS_PAGE_SIZE,
  useAccounts,
  useFixCategory,
  useTransactions,
  type Period,
} from '@/lib/api/hooks';
import type { TransactionFilters } from '@/lib/api/keys';
import type { Category, Transaction } from '@/lib/api/types';
import { categoryInfo } from '@/lib/categories';
import { formatNumber } from '@/lib/money';
import { countSources, periodText } from './spending-format';
import { TransactionTable } from './TransactionTable';

type FixResult =
  | { kind: 'saved'; merchant: string; relabeled: number }
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
  const others =
    result.relabeled === 0
      ? ''
      : ` ${formatNumber(result.relabeled)} other ${
          result.relabeled === 1 ? 'transaction was' : 'transactions were'
        } relabeled.`;
  return (
    <Notice tone="confirmed" compact role="status">
      Saved as a rule. {result.merchant} will never go back to the AI for you.{others}
    </Notice>
  );
}

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

/** The period's rows; the newest rows without a period; nothing until it is known. */
function filtersFor(period: Period | null | undefined): TransactionFilters | null {
  if (period === undefined) return null;
  return period ? periodFilters(period) : { limit: TRANSACTIONS_PAGE_SIZE };
}

export interface TransactionsCardProps {
  /**
   * The period the summary shows (spec 003 rule 17a). Undefined while it is
   * not known yet (the API's default period has not answered); null when it
   * cannot be known (the cash flow failed), and the newest rows are listed.
   */
  period: Period | null | undefined;
}

/**
 * The mockup's transactions card: who labeled what, the period's table, and
 * the category fix. A fix shows at once (useFixCategory is optimistic); the
 * notice says the server saved it as a rule, or that it went back. While
 * another period loads, the last rows stay on screen and the card is busy.
 */
export function TransactionsCard({ period }: TransactionsCardProps) {
  const list = useTransactions(filtersFor(period));
  const accounts = useAccounts().data;
  const fix = useFixCategory();
  const [result, setResult] = useState<FixResult | null>(null);

  const masks = useMemo(
    () => new Map((accounts ?? []).map((a) => [a.id, a.mask] as const)),
    [accounts],
  );
  const counts = countSources(list.transactions);

  const onCategoryChange = (txn: Transaction, category: Category) => {
    const merchant = txn.merchant_clean ?? txn.merchant_raw;
    const previous = txn.category ? categoryInfo(txn.category).label : 'no category';
    setResult(null);
    fix.mutate(
      { transactionId: txn.id, category },
      {
        onSuccess: (saved) =>
          setResult(saved.rule ? { kind: 'saved', merchant, relabeled: saved.relabeled } : null),
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
      period && accounts?.length !== 0 ? (
        <p className="m-0 text-small text-ink-3">
          No transactions from {periodText(period.start, period.end)}. Pick another period above.
        </p>
      ) : (
        <p className="m-0 text-small text-ink-3">
          No transactions yet. <Link href="/setup/link">Link a bank</Link> on the first step and
          they appear here once the sync finishes.
        </p>
      );
  } else {
    body = (
      <>
        <TransactionTable
          transactions={list.transactions}
          masks={masks}
          onCategoryChange={onCategoryChange}
        />
        {list.hasNextPage && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
              Load more transactions
            </Button>
            <span className="text-small text-ink-3">
              Counts cover the {formatNumber(list.transactions.length)} transactions loaded so far.
            </span>
          </div>
        )}
      </>
    );
  }

  return (
    <Card aria-labelledby="txn-title" gap={12} aria-busy={list.isPlaceholderData || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="txn-title" className="m-0">
          Transactions
        </h2>
        {list.transactions.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <Badge>{formatNumber(counts.rule)} by rule</Badge>
            <Badge tone="blue">{formatNumber(counts.llm)} by AI</Badge>
            <Badge tone="confirmed">{formatNumber(counts.user)} fixed by you</Badge>
          </div>
        )}
      </div>
      {result && <FixNotice result={result} />}
      {body}
      <p className="m-0 text-tiny text-ink-3">
        Category groups: essentials are housing, groceries, utilities, phone, transport, insurance
        and healthcare. Flexible is dining, shopping, subscriptions, entertainment and travel.
        Savings is any transfer into savings or investments.
      </p>
    </Card>
  );
}
