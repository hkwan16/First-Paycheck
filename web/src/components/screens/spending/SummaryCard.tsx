'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatTile } from '@/components/ui/StatTile';
import { maskLabel } from '@/lib/accounts';
import { apiErrorMessage } from '@/lib/api/errors';
import { useAccounts } from '@/lib/api/hooks';
import type { Account, AccountKind, SpendingSummary } from '@/lib/api/types';
import { formatNumber } from '@/lib/money';
import { ledgerNote, periodText, shareText as share } from './spending-format';

const list = new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' });

/**
 * "Chase ··4821 and ··7730": the active accounts the totals cover, of the
 * kinds the API says it read (`account_kinds_counted`) once the totals are in.
 */
function accountsText(accounts: readonly Account[], kinds?: readonly AccountKind[]): string {
  const byInstitution = new Map<string, string[]>();
  for (const account of accounts) {
    if (!account.is_active || (kinds && !kinds.includes(account.kind))) continue;
    const name = account.institution_name ?? 'Linked bank';
    const masks = byInstitution.get(name) ?? [];
    masks.push(maskLabel(account.mask) ?? account.name);
    byInstitution.set(name, masks);
  }
  return list.format([...byInstitution].map(([name, masks]) => `${name} ${list.format(masks)}`));
}

/** "Not yet spent: $1,618.94 ..." or, when spending ran past income, by how much. */
function LeftOver({ cents }: { cents: number }) {
  const amount = (
    <strong className="text-ink">
      <Money cents={cents} />
    </strong>
  );
  return cents < 0 ? (
    <>Spent more than came in: {amount} from your accounts.</>
  ) : (
    <>Not yet spent: {amount} is still in your accounts.</>
  );
}

export interface SummaryCardProps {
  /** The period's totals from `GET /cashflow` (`spending`); undefined while loading. */
  summary: SpendingSummary | undefined;
  /** Another period is on its way; the last one stays on screen. */
  updating?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** The period picker, in the header row. */
  picker?: ReactNode;
}

/**
 * The mockup's summary card: income, essentials, flexible and savings for
 * the period, and what is left. Every total and percentage is the API's
 * (`calc/spending.py`); the card only formats them.
 */
export function SummaryCard({ summary, updating, error, onRetry, picker }: SummaryCardProps) {
  const accounts = useAccounts().data ?? [];
  const loading = summary === undefined;
  const failed = loading && error != null;
  const paychecks =
    summary &&
    `${formatNumber(summary.paycheck_count)} ${summary.paycheck_count === 1 ? 'paycheck' : 'paychecks'}`;
  const covered = accountsText(accounts, summary?.account_kinds_counted);
  const ledgers = summary && ledgerNote(summary.ledger_rows_skipped);

  return (
    <Card aria-labelledby="summary-title" aria-busy={(loading && !failed) || updating || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="summary-title" className="m-0">
            {summary
              ? `${periodText(summary.start, summary.end)} · ${paychecks}`
              : 'Your month so far'}
          </h2>
          {covered && <span className="text-small text-ink-3">{covered}</span>}
        </div>
        {picker}
      </div>
      {failed && (
        <Notice tone="warning" compact role="alert" className="items-center">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              Could not load your totals. {apiErrorMessage(error, 'Check your connection.')}
            </span>
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </Notice>
      )}
      <div className="grid grid-cols-4 gap-3 max-wide:grid-cols-2">
        <StatTile
          tone="plum"
          label="Income"
          loading={loading}
          value={summary && <Money cents={summary.income_cents} />}
          sub={summary && `${paychecks}, after taxes and deductions`}
        />
        <StatTile
          tone="blue"
          label="Essentials"
          loading={loading}
          value={summary && <Money cents={summary.essentials_cents} />}
          sub={summary && share(summary.essentials_pct, (p) => `${p} of income`)}
        />
        <StatTile
          tone="coral"
          label="Flexible"
          loading={loading}
          value={summary && <Money cents={summary.flexible_cents} />}
          sub={summary && share(summary.flexible_pct, (p) => `${p} of income`)}
        />
        <StatTile
          tone="teal"
          label="Savings"
          loading={loading}
          value={summary && <Money cents={summary.savings_cents} />}
          sub={summary && share(summary.savings_rate_pct, (p) => `Savings rate ${p}`)}
        />
      </div>
      {summary ? (
        <>
          <p className="m-0 text-small text-ink-3">
            <LeftOver cents={summary.left_over_cents} />
          </p>
          {ledgers && <p className="m-0 text-tiny text-ink-3">{ledgers}</p>}
        </>
      ) : (
        <p className="m-0 text-small text-ink-3">
          <Skeleton className="w-72 max-w-full" />
          <span className="sr-only">Totals are not available yet.</span>
        </p>
      )}
    </Card>
  );
}
