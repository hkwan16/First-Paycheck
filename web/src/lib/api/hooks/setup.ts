import { useMemo } from 'react';
import { features } from '@/lib/features';
import { setupProgress, type SetupFacts, type SetupProgress } from '@/lib/setup-progress';
import { useDecisions, useDocuments, useSpendingSummary } from '../pending';
import { useAccounts } from './accounts';
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
  const documents = useDocuments();
  const summary = useSpendingSummary();
  const decisions = useDecisions();

  return useMemo(
    () => ({
      accounts: accounts?.length ?? 0,
      transactions: transactions.length,
      documents: documents?.length ?? 0,
      confirmedPayStubs:
        documents?.filter((d) => d.kind === 'pay_stub' && d.status === 'confirmed').length ?? 0,
      categorizationFinished: summary !== undefined && summary.uncategorized_count === 0,
      liveCalculators: features.calculators,
      savedDecisionCalculators: decisions?.map((d) => d.calculator) ?? [],
    }),
    [accounts, transactions, documents, summary, decisions],
  );
}

/** Done marks for the side nav. */
export function useSetupProgress(): SetupProgress {
  const facts = useSetupFacts();
  return useMemo(() => setupProgress(facts), [facts]);
}
