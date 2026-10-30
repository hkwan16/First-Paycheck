'use client';

import Link from 'next/link';
import type { FlowNode } from '@/components/sankey';
import { Money } from '@/components/ui/Money';
import { maskLabel } from '@/lib/accounts';
import type {
  AccountKind,
  CashFlow,
  SpendingSummary,
  Transaction,
  WithholdingLine,
} from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { formatNumber, formatTransactionAmount } from '@/lib/money';
import { shareText } from './spending-format';
import { SourceBadge } from './TransactionTable';
import { decisionStepRoute } from '@/lib/routes';

/** How many of a category's transactions the popover lists. */
export const POPOVER_LINES = 8;

const list = new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' });

const count = (n: number, one: string, many: string) =>
  `${formatNumber(n)} ${n === 1 ? one : many}`;

const ROLE_TEXT: Record<WithholdingLine['role'], string> = {
  tax: 'Withheld for taxes',
  retirement: 'Saved for retirement from gross pay',
  health: 'Taken out for health coverage',
  other: 'Other payroll deductions',
};

const Muted = ({ children }: { children: React.ReactNode }) => (
  <p className="m-0 text-tiny text-ink-3">{children}</p>
);

export interface FlowDetailsProps {
  node: FlowNode;
  flow: CashFlow;
  /** The transactions loaded for the table, newest first. */
  transactions: readonly Transaction[];
  /** account_id to its mask ("4821"). */
  masks: ReadonlyMap<string, string | null>;
  /** account_id to its kind, to leave out the ledgers the API does not count. */
  kinds: ReadonlyMap<string, AccountKind>;
}

/** A bucket's share of income in the summary; the other buckets have none. */
const BUCKET_SHARES = {
  essentials: (s: SpendingSummary) => s.essentials_pct,
  flexible: (s: SpendingSummary) => s.flexible_pct,
  savings: (s: SpendingSummary) => s.savings_rate_pct,
} as const;

/**
 * What a Sankey node's popover says under its name and amount. Every number
 * is one the API sent (amounts, percentages, counts); the category lines are
 * the loaded transactions of that category in the period on the accounts the
 * API counted, as the table lists them.
 */
export function FlowDetails({ node, flow, transactions, masks, kinds }: FlowDetailsProps) {
  const stubs = flow.withholding.paycheck_count;
  const stubWords = count(stubs, 'pay stub', 'pay stubs');

  switch (node.kind) {
    case 'gross':
      if (stubs === 0) {
        return (
          <Muted>
            No confirmed pay stub was paid in this period.{' '}
            <Link href="/setup/confirm">Confirm one from it</Link> to see gross pay and withholding.
          </Muted>
        );
      }
      return (
        <Muted>
          {stubWords}:{' '}
          {list.format(flow.pay_stubs.map((stub) => formatDate(stub.pay_date, 'short')))}
        </Muted>
      );

    case 'line': {
      const line = flow.withholding.lines.find((l) => l.key === node.key);
      if (node.zero && node.key === 'retirement_contribution') {
        return (
          <div className="flex flex-col gap-1">
            <Muted>Nothing went to a 401(k) from {stubWords}.</Muted>
            <Link href={decisionStepRoute('401k_match')} className="text-small">
              See what a 401(k) match is worth
            </Link>
          </div>
        );
      }
      return <Muted>{line ? `${ROLE_TEXT[line.role]}, on ${stubWords}` : stubWords}</Muted>;
    }

    case 'take-home':
      if (stubs === 0) {
        return (
          <Muted>
            Deposits labeled income in this period. A confirmed pay stub shows what came before
            them.
          </Muted>
        );
      }
      return (
        <dl className="m-0 flex flex-col gap-0.5 text-tiny text-ink-3">
          <div>
            <dt className="inline">Net pay on {stubWords}: </dt>
            <dd className="inline">
              <Money cents={flow.withholding.net_cents} className="font-semibold text-ink" />
            </dd>
          </div>
          <div>
            <dt className="inline">Deposited as income: </dt>
            <dd className="inline">
              <Money cents={flow.spending.income_cents} className="font-semibold text-ink" />
            </dd>
          </div>
        </dl>
      );

    case 'bucket': {
      const share = BUCKET_SHARES[node.key as keyof typeof BUCKET_SHARES];
      if (share) {
        return <Muted>{shareText(share(flow.spending), (p) => `${p} of income`, 1)}</Muted>;
      }
      if (node.key === 'left_over') {
        return (
          <Muted>
            {node.cents < 0
              ? 'Spending ran past the income deposited in this period.'
              : 'Still in your accounts, not spent or moved.'}
          </Muted>
        );
      }
      return <Muted>Debt payments, fees, taxes and other spending</Muted>;
    }

    case 'category': {
      const total = flow.spending.categories.find((c) => c.category === node.key);
      // The rows the API counted: posted, in the period, and not on a loan,
      // investment or retirement ledger (spec 007 rule 21a).
      const counted = (accountId: string) => {
        const kind = kinds.get(accountId);
        return kind === undefined || flow.spending.account_kinds_counted.includes(kind);
      };
      const lines = transactions
        .filter(
          (t) =>
            t.category === node.key &&
            !t.pending &&
            t.posted_at >= flow.start &&
            t.posted_at <= flow.end &&
            counted(t.account_id),
        )
        .slice(0, POPOVER_LINES);
      return (
        <div className="flex flex-col gap-2">
          {total && (
            <Muted>{count(total.count, 'transaction', 'transactions')} in this period</Muted>
          )}
          {lines.length > 0 && (
            <ul className="m-0 flex list-none flex-col p-0">
              {lines.map((t) => {
                const account = maskLabel(masks.get(t.account_id) ?? null);
                return (
                  <li
                    key={t.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2.5 gap-y-1 border-t border-line py-1.5 text-code first:border-t-0 first:pt-0"
                  >
                    <span className="truncate font-semibold">
                      {t.merchant_clean ?? t.merchant_raw}
                    </span>
                    <SourceBadge transaction={t} />
                    <span className="text-right font-semibold tabular-nums">
                      {formatTransactionAmount(t.amount_cents)}
                    </span>
                    <span className="col-span-full -mt-0.5 text-tiny text-ink-3 tabular-nums">
                      {formatDate(t.posted_at, 'short')}
                      {account ? ` · ${account}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <Muted>Fix a label in the table below and this total follows.</Muted>
        </div>
      );
    }
  }
}
