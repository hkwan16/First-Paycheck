import type { CalculatorId } from './features';

/*
 * The Decisions steps (spec 018): one page per calculator, in the mockup's
 * order. The W-4 reads the saved 401(k) and health plan decisions, so it
 * comes last. Routes are built in lib/routes.ts.
 */

export const DECISION_STEPS = [
  'emergency_fund',
  '401k_match',
  'health_plan',
  'w4',
] as const satisfies readonly CalculatorId[];

export interface StepText {
  /** The page's heading: the decision, in the person's words. */
  title: string;
  /** The tab title and the side nav's label. */
  label: string;
  /** Mid-sentence, in the footer: "Back to health plan", "Next: W-4". */
  name: string;
}

export const STEP_TEXT: Record<CalculatorId, StepText> = {
  emergency_fund: {
    title: 'How much to keep for emergencies',
    label: 'Emergency fund',
    name: 'emergency fund',
  },
  '401k_match': {
    title: 'How much to put in your 401(k)',
    label: '401(k) match',
    name: '401(k) match',
  },
  health_plan: {
    title: 'Which health plan to choose',
    label: 'Health plan',
    name: 'health plan',
  },
  w4: { title: 'What to put on your W-4', label: 'W-4', name: 'W-4' },
};

/** The step's place in the order, from 1, counting every calculator live or not. */
export const stepNumber = (calculator: CalculatorId) => DECISION_STEPS.indexOf(calculator) + 1;

/** The live steps in step order. */
const liveSteps = (live: readonly CalculatorId[]) =>
  DECISION_STEPS.filter((step) => live.includes(step));

/**
 * The live steps on either side of a step's place in the order (spec 018
 * rule 6); null where none is left. A step that is not live has the same
 * neighbors it would have if it were.
 */
export function liveNeighbors(
  calculator: CalculatorId,
  live: readonly CalculatorId[],
): { previous: CalculatorId | null; next: CalculatorId | null } {
  const place = stepNumber(calculator);
  const steps = liveSteps(live);
  return {
    previous: steps.findLast((step) => stepNumber(step) < place) ?? null,
    next: steps.find((step) => stepNumber(step) > place) ?? null,
  };
}

/** Where Decisions starts: the first live step, else the first step. */
export const firstLiveStep = (live: readonly CalculatorId[]): CalculatorId =>
  liveSteps(live)[0] ?? DECISION_STEPS[0];

/** Where Decisions ends: the last live step, else the last step. */
export const lastLiveStep = (live: readonly CalculatorId[]): CalculatorId =>
  liveSteps(live).at(-1) ?? DECISION_STEPS[3];
