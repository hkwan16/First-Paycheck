import { useMemo } from 'react';
import { features } from '@/lib/features';
import { setupProgress, type SetupFacts, type SetupProgress } from '@/lib/setup-progress';
import { calculatorIdOf } from '@/lib/decisions';
import { useAccounts } from './accounts';
import { useDecisions } from './decisions';
import { useDocuments } from './documents';
import { usePlan } from './plan';
import { usePayStubs } from './profile';
import { useSpendingSummary } from './spending';
import { NEWEST_TRANSACTIONS, useTransactions } from './transactions';

/**
 * The counts and states `setupProgress` compares, from the API.
 */
export function useSetupFacts(): SetupFacts {
  const accounts = useAccounts().data;
  // Whether any transaction has synced, whatever its date: no period.
  const { transactions } = useTransactions(NEWEST_TRANSACTIONS);
  const documents = useDocuments().data;
  const payStubs = usePayStubs().data;
  // The default period, as the Spending screen opens on it.
  const summary = useSpendingSummary().data;
  const decisions = useDecisions().data;
  const plan = usePlan().data;

  return useMemo(
    () => ({
      accounts: accounts?.length ?? 0,
      transactions: transactions.length,
      documents: documents?.length ?? 0,
      confirmedPayStubs: payStubs?.length ?? 0,
      categorizationFinished: summary !== undefined && summary.uncategorized_count === 0,
      liveCalculators: features.calculators,
      savedDecisionCalculators: decisions?.items.map((d) => calculatorIdOf(d.calculator)) ?? [],
      planMissingCount: plan ? plan.completeness.missing.length : null,
    }),
    [accounts, transactions, documents, payStubs, summary, decisions, plan],
  );
}

/** Done marks for the side nav. */
export function useSetupProgress(): SetupProgress {
  const facts = useSetupFacts();
  return useMemo(() => setupProgress(facts), [facts]);
}
