'use client';

import Link from 'next/link';
import type { FlowNode } from '@/components/sankey';
import { Money } from '@/components/ui/Money';
import { maskLabel } from '@/lib/accounts';
import type { CashFlow, SpendingSummary, Transaction, WithholdingLine } from '@/lib/api/types';
import { categoryLabel } from '@/lib/categories';
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
  /**
   * The period's transactions loaded for the table, newest first: only rows
   * on the accounts the totals read (`cash_accounts_only`, spec 003 rule 17).
   */
  transactions: readonly Transaction[];
  /** account_id to its mask ("4821"). */
  masks: ReadonlyMap<string, string | null>;
}

/** A bucket's share of income in the summary; the other buckets have none. */
const BUCKET_SHARES = {
  essentials: (s: SpendingSummary) => s.essentials_pct,
  flexible: (s: SpendingSummary) => s.flexible_pct,
  savings: (s: SpendingSummary) => s.savings_rate_pct,
} as const;

/** A bucket's total as the summary counts it, after the money back in its categories. */
const BUCKET_TOTALS = {
  essentials: (s: SpendingSummary) => s.essentials_cents,
  flexible: (s: SpendingSummary) => s.flexible_cents,
  savings: (s: SpendingSummary) => s.savings_cents,
  other: (s: SpendingSummary) => s.other_cents,
} as const;

const isBucketKey = (key: string | null): key is keyof typeof BUCKET_TOTALS =>
  key !== null && key in BUCKET_TOTALS;

/** Take-home on the stubs beside what was deposited: where take-home and the deposits part. */
function PayAndDeposits({ flow, stubWords }: { flow: CashFlow; stubWords: string }) {
  return (
    <dl className="m-0 flex flex-col gap-0.5 text-tiny text-ink-3">
      <div>
        <dt className="inline">Take-home on {stubWords}: </dt>
        <dd className="inline">
          <Money cents={flow.withholding.net_cents} className="font-semibold text-ink" />
        </dd>
      </div>
      <div>
        <dt className="inline">Income deposited in your accounts: </dt>
        <dd className="inline">
          <Money cents={flow.spending.income_cents} className="font-semibold text-ink" />
        </dd>
      </div>
    </dl>
  );
}

/** The categories behind money back (refunds, money out of savings), each as the summary has it. */
function MoneyBack({ node, flow }: { node: FlowNode; flow: CashFlow }) {
  const totals = node.categories.flatMap((key) => {
    const total = flow.spending.categories.find((c) => c.category === key);
    return total ? [total] : [];
  });
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {totals.map((total) => (
        <li
          key={total.category}
          className="flex items-center justify-between gap-2.5 border-t border-line py-1.5 text-code first:border-t-0 first:pt-0"
        >
          <span className="truncate font-semibold">{categoryLabel(total.category)}</span>
          <span className="font-semibold tabular-nums">
            {formatTransactionAmount(total.total_cents)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What a Sankey node's popover says under its name and amount. Every number
 * is one the API sent (amounts, percentages, counts); the category lines are
 * the loaded posted transactions of that category in the period, as the
 * table lists them.
 */
export function FlowDetails({ node, flow, transactions, masks }: FlowDetailsProps) {
  const stubs = flow.withholding.paycheck_count;
  const stubWords = count(stubs, 'pay stub', 'pay stubs');

  switch (node.kind) {
    case 'gross':
      if (stubs === 0) {
        return (
          <Muted>
            No pay stub from this period. <Link href="/setup/confirm">Confirm one</Link> to see what
            comes out of your pay.
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
            <Muted>Nothing went to a 401(k) on {stubWords}.</Muted>
            <Link href={decisionStepRoute('401k_match')} className="text-small">
              See what a 401(k) match is worth
            </Link>
          </div>
        );
      }
      return <Muted>{line ? `${ROLE_TEXT[line.role]}, on ${stubWords}` : stubWords}</Muted>;
    }

    case 'take_home':
      return <PayAndDeposits flow={flow} stubWords={stubWords} />;

    case 'income_deposited':
      return (
        <Muted>
          Pay and other income that reached your accounts. Confirm a pay stub to see what came out
          before payday.
        </Muted>
      );

    case 'other_deposits':
      return (
        <div className="flex flex-col gap-2">
          <PayAndDeposits flow={flow} stubWords={stubWords} />
          <Muted>
            Deposits beyond that take-home: pay with no confirmed stub, interest or other income.
          </Muted>
        </div>
      );

    case 'not_deposited':
      return (
        <div className="flex flex-col gap-2">
          <PayAndDeposits flow={flow} stubWords={stubWords} />
          <Muted>
            Take-home that did not reach a linked account: paid to an account that is not linked, or
            not deposited yet.
          </Muted>
        </div>
      );

    case 'refunds':
      return (
        <div className="flex flex-col gap-2">
          <Muted>Money back that outweighed what was spent in its category this period.</Muted>
          <MoneyBack node={node} flow={flow} />
        </div>
      );

    case 'savings_withdrawn':
      return (
        <div className="flex flex-col gap-2">
          <Muted>More came back out of savings and investments than went in this period.</Muted>
          <MoneyBack node={node} flow={flow} />
        </div>
      );

    case 'beyond_income':
      return (
        <Muted>
          You spent and saved more than came in this period. The rest came from money already in
          your accounts, from savings or on credit.
        </Muted>
      );

    case 'left_over':
      return <Muted>Still in your accounts.</Muted>;

    case 'bucket': {
      const share = BUCKET_SHARES[node.key as keyof typeof BUCKET_SHARES];
      const about = share ? (
        <Muted>{shareText(share(flow.spending), (p) => `${p} of income`, 1)}</Muted>
      ) : (
        <Muted>Debt payments, fees, taxes and other spending</Muted>
      );
      if (node.refundsCents === null || !isBucketKey(node.key)) return about;
      // The node is the spending before the money back (spec 010 rule 5b); the
      // tile beside the diagram is the summary's total after it.
      const after = BUCKET_TOTALS[node.key](flow.spending);
      return (
        <div className="flex flex-col gap-1">
          {about}
          <Muted>
            {node.key === 'savings' ? 'Saved before ' : 'Spent before '}
            <Money cents={node.refundsCents} className="font-semibold text-ink" />
            {node.key === 'savings' ? ' taken back out' : ' of refunds'}. The summary counts{' '}
            <Money cents={after} className="font-semibold text-ink" /> after{' '}
            {node.key === 'savings' ? 'it' : 'them'}.
          </Muted>
        </div>
      );
    }

    case 'category': {
      const total = flow.spending.categories.find((c) => c.category === node.key);
      // The rows the API counted: posted and in the period.
      const lines = transactions
        .filter(
          (t) =>
            t.category === node.key &&
            !t.pending &&
            t.posted_at >= flow.start &&
            t.posted_at <= flow.end,
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
          <Muted>Change a category under Transactions and this total follows.</Muted>
        </div>
      );
    }
  }
}
