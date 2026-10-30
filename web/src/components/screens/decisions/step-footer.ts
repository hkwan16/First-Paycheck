import type { Route } from 'next';
import { liveNeighbors, STEP_TEXT } from '@/lib/decision-steps';
import type { CalculatorId } from '@/lib/features';
import { decisionStepRoute } from '@/lib/routes';

export interface StepFooterLinks {
  back: { href: Route; label?: string };
  next: { label: string; href: Route };
}

/**
 * A decision step's Back and next (spec 018 rule 6): the live steps on either
 * side, else Spending before the first and the plan after the last.
 */
export function stepFooter(
  calculator: CalculatorId,
  live: readonly CalculatorId[],
): StepFooterLinks {
  const { previous, next } = liveNeighbors(calculator, live);
  return {
    back: previous
      ? { href: decisionStepRoute(previous), label: `Back to ${STEP_TEXT[previous].name}` }
      : { href: '/setup/spending' },
    next: next
      ? { label: `Next: ${STEP_TEXT[next].name}`, href: decisionStepRoute(next) }
      : { label: 'See your plan', href: '/plan' },
  };
}
