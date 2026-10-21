'use client';

import { PageTitle } from '@/components/chrome/PageTitle';
import { StepFooter } from '@/components/chrome/StepFooter';
import { useSpendingSummary } from '@/lib/api/pending';
import { monthName } from './spending-format';
import { SummaryCard } from './SummaryCard';
import { TransactionsCard } from './TransactionsCard';

/**
 * Setup step 3, from docs/mockup/Spending.dc.html (alpha version): the
 * period's totals by bucket, then every transaction with who labeled it and
 * a category fix that becomes a rule.
 */
export function SpendingScreen() {
  const summary = useSpendingSummary();
  const title = summary
    ? `Where ${monthName(summary.start)}'s money went`
    : 'Where your money went';

  return (
    <>
      <PageTitle
        title={title}
        lead="Known merchants are labeled by rules. Only unknown ones went to the AI, with a confidence score. Fix any label and it becomes a rule for next time."
      />
      <SummaryCard />
      {/*
        Cash flow diagram slot (Spending.dc.html "Where each dollar of October
        pay went"). Not built in the alpha: it arrives in M5 with
        components/sankey and GET /cashflow, behind the `sankey` feature flag
        (lib/features.ts). Render it here, between the summary and the
        transactions, as `features.sankey && <CashFlowCard />`.
      */}
      <TransactionsCard />
      <StepFooter
        back={{ href: '/setup/link' }}
        next={{ label: 'Use these numbers in decisions', href: '/setup/decisions' }}
      />
    </>
  );
}
