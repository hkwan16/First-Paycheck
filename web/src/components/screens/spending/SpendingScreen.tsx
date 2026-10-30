'use client';

import { useState } from 'react';
import { PageTitle } from '@/components/chrome/PageTitle';
import { StepFooter } from '@/components/chrome/StepFooter';
import { CardErrorBoundary } from '@/components/ui/CardErrorBoundary';
import { NEWEST_TRANSACTIONS, periodFilters, useCashflow, type Period } from '@/lib/api/hooks';
import { features } from '@/lib/features';
import { CashFlowCard } from './CashFlowCard';
import { PeriodPicker } from './PeriodPicker';
import { RecurringCard } from './RecurringCard';
import { monthName } from './spending-format';
import { SummaryCard } from './SummaryCard';
import { TransactionsCard } from './TransactionsCard';
import { firstDecisionRoute } from '@/lib/routes';

export interface SpendingScreenProps {
  /** The cash-flow Sankey; on under the `sankey` feature flag. */
  showSankey?: boolean;
  /** The period to open on; null is the API's default, the last complete month. */
  initialPeriod?: Period | null;
}

/**
 * Setup step 3, from docs/mockup/Spending.dc.html: the period's totals by
 * bucket and, behind the `sankey` flag, where each dollar of pay went (both
 * from one `GET /cashflow`), the recurring charges, then the period's
 * transactions with who labeled each and a category fix that becomes a rule.
 */
export function SpendingScreen({
  showSankey = features.sankey,
  initialPeriod = null,
}: SpendingScreenProps) {
  const [period, setPeriod] = useState<Period | null>(initialPeriod);
  const cashflow = useCashflow(period);
  const flow = cashflow.data;
  const title = flow ? `Where ${monthName(flow.start)}'s money went` : 'Where your money went';
  // The transactions listed (spec 003 rule 17a): the period chosen, else the
  // dates the API answered its default with. Nothing while that answer is on
  // its way (the last period's flow may still be on screen), and the newest
  // rows when the cash flow cannot be read.
  const listed = period ?? (flow && !cashflow.isPlaceholderData ? flow : null);
  const transactions = listed
    ? periodFilters(listed)
    : cashflow.isError
      ? NEWEST_TRANSACTIONS
      : null;

  return (
    <>
      <PageTitle
        title={title}
        lead="Known merchants are labeled by rules. Only unknown ones went to the AI, with a confidence score. Fix any label and it becomes a rule for next time."
      />
      <CardErrorBoundary title="Spending summary">
        <SummaryCard
          summary={flow?.spending}
          updating={cashflow.isPlaceholderData}
          error={cashflow.error}
          onRetry={() => void cashflow.refetch()}
          picker={<PeriodPicker value={period} shown={flow} onChange={setPeriod} />}
        />
      </CardErrorBoundary>
      {showSankey && !cashflow.isError && (
        <CardErrorBoundary title="Where each dollar of pay went">
          <CashFlowCard flow={flow} updating={cashflow.isPlaceholderData} />
        </CardErrorBoundary>
      )}
      <CardErrorBoundary title="Recurring charges">
        <RecurringCard />
      </CardErrorBoundary>
      <CardErrorBoundary title="Transactions">
        <TransactionsCard filters={transactions} />
      </CardErrorBoundary>
      <StepFooter
        back={{ href: '/setup/link' }}
        next={{ label: 'Use these numbers in decisions', href: firstDecisionRoute() }}
      />
    </>
  );
}
