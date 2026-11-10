import { CALCULATORS, type CalculatorId } from './features';

/** The four setup steps the side nav lists. */
export type SetupStep = 'link' | 'confirm' | 'spending' | 'decisions';
/** The side nav items that get a done mark: the setup steps, each decision step and the plan. */
export type ProgressKey = SetupStep | CalculatorId | 'plan';
export type SetupProgress = Record<ProgressKey, boolean>;

/** Counts and states read from the API; this module only compares them. */
export interface SetupFacts {
  accounts: number;
  documents: number;
  confirmedPayStubs: number;
  transactions: number;
  categorizationFinished: boolean;
  liveCalculators: readonly CalculatorId[];
  /** The calculators with a saved decision that needs no review (spec 007 rule 19b). */
  settledDecisionCalculators: readonly CalculatorId[];
  /** How many calculators `GET /plan` lists as missing; null until the plan loads. */
  planMissingCount: number | null;
  /** How many saved decisions `GET /plan` lists as needing review; null until it loads. */
  planNeedsReviewCount: number | null;
}

/**
 * Which setup steps are done, and whether the plan is whole, for the side
 * nav's check marks. A decision step is done when its calculator is live and
 * its saved decision needs no review (spec 018 rule 8, issue 222: a step whose
 * numbers were figured on a pay schedule the person no longer has is not
 * done); Decisions, when every live one is.
 */
export function setupProgress(facts: SetupFacts): SetupProgress {
  const saved = new Set(facts.settledDecisionCalculators);
  const live = new Set(facts.liveCalculators);
  const steps = Object.fromEntries(
    CALCULATORS.map((id) => [id, live.has(id) && saved.has(id)]),
  ) as Record<CalculatorId, boolean>;
  return {
    ...steps,
    link: facts.accounts > 0 && facts.documents > 0,
    confirm: facts.confirmedPayStubs > 0,
    spending: facts.transactions > 0 && facts.categorizationFinished,
    decisions:
      facts.liveCalculators.length > 0 && facts.liveCalculators.every((id) => saved.has(id)),
    // The API's completeness: every calculator saved, live in this build or not,
    // and none needing review (spec 016 rule 3a).
    plan: facts.planMissingCount === 0 && facts.planNeedsReviewCount === 0,
  };
}
