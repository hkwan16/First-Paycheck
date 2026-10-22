'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { ACCOUNT_KIND_LABELS, maskLabel } from '@/lib/accounts';
import { apiErrorMessage } from '@/lib/api/errors';
import { useHoldings, useNetWorth } from '@/lib/api/hooks';
import type { AccountBalance, AccountRole, NetWorth } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { HoldingsTable } from './HoldingsTable';
import { netWorthChartData } from './net-worth-chart';
import { NetWorthChart } from './NetWorthChart';

/** How many calendar months the series covers, ending with this one. */
export const NET_WORTH_MONTHS = 12;

const ROLE_LABELS: Record<AccountRole, string> = {
  spending: 'Spending',
  emergency_fund: 'Emergency fund',
  retirement: 'Retirement',
};

function accountNote(account: AccountBalance): string {
  const what = account.role ? ROLE_LABELS[account.role] : ACCOUNT_KIND_LABELS[account.kind];
  return account.side === 'liability' ? `${what} · owed` : what;
}

function MonthlyTable({ netWorth }: { netWorth: NetWorth }) {
  const rows = netWorthChartData(netWorth.series);
  return (
    <details className="text-small">
      <summary className="cursor-pointer text-ink-2">Monthly figures</summary>
      <table
        aria-label="Net worth by month"
        className="mt-2 w-full border-collapse text-small tabular-nums"
      >
        <thead>
          <tr className="text-tiny font-semibold text-ink-3">
            <th scope="col" className="pb-1 text-left font-semibold">
              Month
            </th>
            <th scope="col" className="pb-1 pl-3 text-right font-semibold">
              Assets
            </th>
            <th scope="col" className="pb-1 pl-3 text-right font-semibold">
              Liabilities
            </th>
            <th scope="col" className="pb-1 pl-3 text-right font-semibold">
              Net worth
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.month} className="border-t border-line">
              <th scope="row" className="py-1.5 text-left font-normal">
                {row.name}
              </th>
              <td className="py-1.5 pl-3 text-right">
                <Money cents={row.assets} />
              </td>
              <td className="py-1.5 pl-3 text-right">
                <Money cents={row.liabilities} />
              </td>
              <td className="py-1.5 pl-3 text-right font-semibold">
                <Money cents={row.netWorth} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Holdings() {
  const holdings = useHoldings();
  const data = holdings.data;
  let body;
  if (holdings.isError) {
    body = (
      <Notice tone="warning" compact role="alert">
        {apiErrorMessage(holdings.error, 'Could not load your holdings. Reload to try again.')}
      </Notice>
    );
  } else if (!data) {
    body = (
      <div aria-busy="true">
        <span className="sr-only">Loading your holdings</span>
        <Skeleton block className="h-6 w-full" />
      </div>
    );
  } else if (data.accounts.length === 0) {
    body = (
      <p className="m-0 text-small text-ink-3">
        No investment holdings reported. Positions show here once a linked investment or retirement
        account sends them.
      </p>
    );
  } else {
    body = <HoldingsTable holdings={data} />;
  }
  return (
    <section
      aria-labelledby="holdings-title"
      className="flex flex-col gap-2 rounded-control bg-tile px-3.5 py-3"
    >
      <h3 id="holdings-title" className="m-0 text-small font-semibold">
        Investment holdings
      </h3>
      {body}
    </section>
  );
}

/**
 * Net worth (spec 015 rule 20), from docs/mockup/CheckIn.dc.html's card:
 * the figure, assets and liabilities, the change over the series, the
 * monthly chart and its table, each account's balance, and the newest
 * investment holdings. Every amount is `GET /net-worth`'s or
 * `GET /holdings`'s, formatted.
 */
export function NetWorthCard({ className }: { className?: string }) {
  const netWorth = useNetWorth(NET_WORTH_MONTHS);
  const data = netWorth.data;

  let body;
  if (netWorth.isError) {
    body = (
      <Notice tone="warning" compact role="alert">
        {apiErrorMessage(netWorth.error, 'Could not load your net worth. Reload to try again.')}
      </Notice>
    );
  } else if (!data) {
    body = (
      <div aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading your net worth</span>
        <Skeleton className="h-8 w-40" />
        <Skeleton block className="h-40 w-full" />
      </div>
    );
  } else if (data.as_of === null) {
    body = (
      <p className="m-0 text-small text-ink-3">
        No balances yet. Your net worth shows here once a linked account reports one.{' '}
        <Link href="/setup/link">Link an account</Link>
      </p>
    );
  } else {
    body = (
      <>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div>
            <div className="text-display font-bold">{formatMoney(data.net_worth_cents)}</div>
            <div className="text-tiny text-ink-3">As of {formatDate(data.as_of)}</div>
          </div>
          <dl className="m-0 flex gap-4 text-small">
            <div>
              <dt className="text-tiny text-ink-3">Assets</dt>
              <dd className="m-0 font-semibold">
                <Money cents={data.assets_cents} />
              </dd>
            </div>
            <div>
              <dt className="text-tiny text-ink-3">Liabilities</dt>
              <dd className="m-0 font-semibold">
                <Money cents={data.liabilities_cents} />
              </dd>
            </div>
          </dl>
        </div>
        {data.series.length > 0 && <NetWorthChart series={data.series} />}
        {data.series.length > 0 && <MonthlyTable netWorth={data} />}
        <ul aria-label="Accounts" className="m-0 flex list-none flex-col p-0">
          {data.accounts.map((account) => (
            <li
              key={account.account_id}
              className="flex justify-between gap-3 border-t border-line py-2.5 text-control first:border-t-0 first:pt-0"
            >
              <span className="min-w-0">
                <span>{account.name}</span>
                {account.mask && (
                  <span className="ml-1.5 text-ink-3 tabular-nums">{maskLabel(account.mask)}</span>
                )}
                <span className="block text-tiny text-ink-3">{accountNote(account)}</span>
              </span>
              <Money cents={account.balance_cents} />
            </li>
          ))}
        </ul>
        <Holdings />
      </>
    );
  }

  const first = data?.series[0];
  return (
    <Card aria-labelledby="nw-title" gap={14} className={className}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="nw-title" className="m-0">
          Net worth
        </h2>
        {data && first && data.change_cents !== null && (
          <Badge>
            <span className="tabular-nums">
              {formatMoney(data.change_cents, { signed: true })} since{' '}
              {formatDate(first.month, 'month-year')}
            </span>
          </Badge>
        )}
      </div>
      {body}
    </Card>
  );
}
