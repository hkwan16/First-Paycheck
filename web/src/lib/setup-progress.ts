import type { CalculatorId } from './features';

export const SETUP_STEPS = ['link', 'confirm', 'spending', 'decisions'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type SetupProgress = Record<SetupStep, boolean>;

/** Counts and states read from the API; this module only compares them. */
export interface SetupFacts {
  accounts: number;
  documents: number;
  confirmedPayStubs: number;
  transactions: number;
  categorizationFinished: boolean;
  liveCalculators: readonly CalculatorId[];
  savedDecisionCalculators: readonly CalculatorId[];
}

/** Which setup steps are done, for the side nav's check marks. */
export function setupProgress(facts: SetupFacts): SetupProgress {
  const saved = new Set(facts.savedDecisionCalculators);
  return {
    link: facts.accounts > 0 && facts.documents > 0,
    confirm: facts.confirmedPayStubs > 0,
    spending: facts.transactions > 0 && facts.categorizationFinished,
    decisions:
      facts.liveCalculators.length > 0 && facts.liveCalculators.every((id) => saved.has(id)),
  };
}
