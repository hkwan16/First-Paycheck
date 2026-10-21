'use client';

import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatTile } from '@/components/ui/StatTile';
import { useAccounts } from '@/lib/api/hooks';
import { useSpendingSummary } from '@/lib/api/pending';
import type { Account } from '@/lib/api/types';
import { formatNumber, formatPct } from '@/lib/money';
import { maskLabel } from '@/lib/accounts';
import { periodText } from './spending-format';

const list = new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' });

/** "Chase ··4821 and ··7730": the active accounts the totals cover. */
function accountsText(accounts: readonly Account[]): string {
  const byInstitution = new Map<string, string[]>();
  for (const account of accounts) {
    if (!account.is_active) continue;
    const name = account.institution_name ?? 'Linked bank';
    const masks = byInstitution.get(name) ?? [];
    masks.push(maskLabel(account.mask) ?? account.name);
    byInstitution.set(name, masks);
  }
  return list.format([...byInstitution].map(([name, masks]) => `${name} ${list.format(masks)}`));
}

/**
 * The mockup's summary card: income, essentials, flexible and savings for
 * the period. Every total comes from `GET /spending/summary`; until that
 * route exists the tiles stay skeletons rather than adding up transactions
 * here (no money math in the client).
 */
export function SummaryCard() {
  const summary = useSpendingSummary();
  const accounts = useAccounts().data ?? [];
  const loading = summary === undefined;
  const paychecks =
    summary &&
    `${formatNumber(summary.paycheck_count)} ${summary.paycheck_count === 1 ? 'paycheck' : 'paychecks'}`;

  return (
    <Card aria-labelledby="summary-title" aria-busy={loading || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="summary-title" className="m-0">
          {summary
            ? `${periodText(summary.start, summary.end)} · ${paychecks}`
            : 'Your month so far'}
        </h2>
        {accounts.length > 0 && (
          <span className="text-small text-ink-3">{accountsText(accounts)}</span>
        )}
      </div>
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
          sub={summary && `${formatPct(summary.essentials_pct)} of income`}
        />
        <StatTile
          tone="coral"
          label="Flexible"
          loading={loading}
          value={summary && <Money cents={summary.flexible_cents} />}
          sub={summary && `${formatPct(summary.flexible_pct)} of income`}
        />
        <StatTile
          tone="teal"
          label="Savings"
          loading={loading}
          value={summary && <Money cents={summary.savings_cents} />}
          sub={summary && `Savings rate ${formatPct(summary.savings_rate_pct)}`}
        />
      </div>
      {summary ? (
        <p className="m-0 text-small text-ink-3">
          Not yet spent:{' '}
          <strong className="text-ink">
            <Money cents={summary.left_cents} />
          </strong>{' '}
          is still in your accounts.
        </p>
      ) : (
        <p className="m-0 text-small text-ink-3">
          <Skeleton className="w-72 max-w-full" />
          <span className="sr-only">Totals are not available yet.</span>
        </p>
      )}
    </Card>
  );
}
