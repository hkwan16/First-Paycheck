import { useMemo } from 'react';
import { features } from '@/lib/features';
import { setupProgress, type SetupFacts, type SetupProgress } from '@/lib/setup-progress';
import { useDecisions } from '../pending';
import { useAccounts } from './accounts';
import { useDocuments } from './documents';
import { usePayStubs } from './profile';
import { useSpendingSummary } from './spending';
import { useTransactions } from './transactions';

/** The page size the Spending screen reads; sharing it shares the cache. */
export const TRANSACTIONS_PAGE_SIZE = 50;

/**
 * The counts and states `setupProgress` compares, from the API. Reads whose
 * routes do not exist yet (pending.ts) count as nothing done.
 */
export function useSetupFacts(): SetupFacts {
  const accounts = useAccounts().data;
  const { transactions } = useTransactions({ limit: TRANSACTIONS_PAGE_SIZE });
  const documents = useDocuments().data;
  const payStubs = usePayStubs().data;
  // The default period, as the Spending screen opens on it.
  const summary = useSpendingSummary().data;
  const decisions = useDecisions();

  return useMemo(
    () => ({
      accounts: accounts?.length ?? 0,
      transactions: transactions.length,
      documents: documents?.length ?? 0,
      confirmedPayStubs: payStubs?.length ?? 0,
      categorizationFinished: summary !== undefined && summary.uncategorized_count === 0,
      liveCalculators: features.calculators,
      savedDecisionCalculators: decisions?.map((d) => d.calculator) ?? [],
    }),
    [accounts, transactions, documents, payStubs, summary, decisions],
  );
}

/** Done marks for the side nav. */
export function useSetupProgress(): SetupProgress {
  const facts = useSetupFacts();
  return useMemo(() => setupProgress(facts), [facts]);
}
