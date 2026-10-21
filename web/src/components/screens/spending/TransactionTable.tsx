'use client';

import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Swatch } from '@/components/ui/Swatch';
import { maskLabel } from '@/lib/accounts';
import type { Category, Transaction } from '@/lib/api/types';
import { BUCKETS, categoryGroups, categoryInfo } from '@/lib/categories';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { toneText } from '@/lib/design/tone';
import { formatTransactionAmount, transactionFlow } from '@/lib/money';
import { sourceBadge } from './spending-format';

/*
 * From the mockup's `.trow`: date, merchant and account, who labeled it, the
 * category select with its bucket swatch, and the signed amount. A grid of
 * ARIA table rows, so the five columns can stack into three lines when the
 * card is narrow (a container query, since the card's width, not the
 * viewport's, decides whether five columns fit).
 */
const ROW = cn(
  'grid items-center gap-x-3 gap-y-1.5 border-t border-line py-2.5',
  'grid-cols-[minmax(0,1fr)_auto] [grid-template-areas:"merchant_amount"_"date_source"_"category_category"]',
  '@min-[42rem]:grid-cols-[64px_minmax(180px,1fr)_110px_190px_96px] @min-[42rem]:[grid-template-areas:"date_merchant_source_category_amount"]',
);

const GROUPS = categoryGroups();

export function SourceBadge({ transaction }: { transaction: Transaction }) {
  const { tone, text } = sourceBadge(transaction);
  return <Badge tone={tone}>{text}</Badge>;
}

export interface TransactionTableProps {
  transactions: readonly Transaction[];
  /** account_id to mask, for the "··4821" under each merchant. */
  masks: ReadonlyMap<string, string | null>;
  onCategoryChange: (transaction: Transaction, category: Category) => void;
}

export function TransactionTable({ transactions, masks, onCategoryChange }: TransactionTableProps) {
  return (
    <div role="table" aria-label="Transactions" className="@container">
      <div role="rowgroup">
        <div
          role="row"
          className={cn(
            ROW,
            'border-t-0 pt-0 pb-1.5 text-tiny font-semibold tracking-[0.03em] text-ink-3 uppercase',
            // Narrow cards stack each row, so the header row is for screen readers only.
            '@max-[42rem]:sr-only',
          )}
        >
          <span role="columnheader" className="[grid-area:date]">
            Date
          </span>
          <span role="columnheader" className="[grid-area:merchant]">
            Merchant
          </span>
          <span role="columnheader" className="[grid-area:source]">
            Labeled by
          </span>
          <span role="columnheader" className="[grid-area:category]">
            Category
          </span>
          <span role="columnheader" className="text-right [grid-area:amount]">
            Amount
          </span>
        </div>
      </div>
      <div role="rowgroup">
        {transactions.map((txn) => (
          <TransactionRow
            key={txn.id}
            transaction={txn}
            mask={maskLabel(masks.get(txn.account_id) ?? null)}
            onCategoryChange={onCategoryChange}
          />
        ))}
      </div>
    </div>
  );
}

function TransactionRow({
  transaction: txn,
  mask,
  onCategoryChange,
}: {
  transaction: Transaction;
  mask: string | null;
  onCategoryChange: TransactionTableProps['onCategoryChange'];
}) {
  const merchant = txn.merchant_clean ?? txn.merchant_raw;
  const bucket = txn.category ? categoryInfo(txn.category).bucket : null;
  const flow = transactionFlow(txn.amount_cents);

  return (
    <div role="row" className={ROW}>
      <span role="cell" className="text-small text-ink-3 tabular-nums [grid-area:date]">
        {formatDate(txn.posted_at, 'short')}
        {txn.pending && <span className="block text-tiny">Pending</span>}
      </span>
      <span role="cell" className="min-w-0 [grid-area:merchant]">
        <span className="block truncate font-semibold">{merchant}</span>
        {mask && <span className="text-tiny text-ink-3 tabular-nums">{mask}</span>}
      </span>
      <span
        role="cell"
        className="justify-self-end [grid-area:source] @min-[42rem]:justify-self-start"
      >
        <SourceBadge transaction={txn} />
      </span>
      <span role="cell" className="[grid-area:category]">
        <label className="flex items-center gap-2">
          <Swatch color={bucket ? BUCKETS[bucket].swatch : 'flow-tax'} dashed={bucket === null} />
          <Select
            size="sm"
            aria-label={`Category for ${merchant}`}
            value={txn.category ?? ''}
            onChange={(event) => onCategoryChange(txn, event.currentTarget.value as Category)}
          >
            {txn.category === null && (
              <option value="" disabled>
                Choose a category
              </option>
            )}
            {GROUPS.map((group) => (
              <optgroup key={group.bucket} label={group.label}>
                {group.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </label>
      </span>
      <span
        role="cell"
        className={cn(
          'text-right font-semibold tabular-nums [grid-area:amount]',
          flow === 'in' && toneText.plum,
        )}
      >
        {formatTransactionAmount(txn.amount_cents)}
      </span>
    </div>
  );
}
