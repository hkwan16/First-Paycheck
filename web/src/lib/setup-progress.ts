import { CALCULATORS, type CalculatorId } from './features';

export const SETUP_STEPS = ['link', 'confirm', 'spending', 'decisions'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
/** The side nav items that get a done mark: the setup steps, each decision step and the plan. */
export type ProgressKey = SetupStep | CalculatorId | 'plan';
export type SetupProgress = Record<ProgressKey, boolean>;

/**
 * How many of the four setup steps the nav marks done, for the phone nav's
 * "n of 4 setup steps done" (spec 018 rule 13). A mark not known yet counts as
 * not done, as the list shows it.
 */
export function setupStepsDone(done: Partial<SetupProgress> | undefined): number {
  return SETUP_STEPS.filter((step) => done?.[step] === true).length;
}

/** Counts and states read from the API; this module only compares them. */
export interface SetupFacts {
  accounts: number;
  documents: number;
  confirmedPayStubs: number;
  transactions: number;
  categorizationFinished: boolean;
  liveCalculators: readonly CalculatorId[];
  savedDecisionCalculators: readonly CalculatorId[];
  /** How many calculators `GET /plan` lists as missing; null until the plan loads. */
  planMissingCount: number | null;
}

/**
 * Which setup steps are done, and whether the plan is whole, for the side
 * nav's check marks. A decision step is done when its calculator is live and
 * saved (spec 018 rule 8); Decisions, when every live one is.
 */
export function setupProgress(facts: SetupFacts): SetupProgress {
  const saved = new Set(facts.savedDecisionCalculators);
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
    // The API's completeness: every calculator saved, live in this build or not.
    plan: facts.planMissingCount === 0,
  };
}
