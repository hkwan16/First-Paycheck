'use client';

import { PageTitle } from '@/components/chrome/PageTitle';
import { StepFooter } from '@/components/chrome/StepFooter';
import { CardErrorBoundary } from '@/components/ui/CardErrorBoundary';
import { useDecisions } from '@/lib/api/hooks';
import { DECISION_STEPS, STEP_TEXT, stepNumber } from '@/lib/decision-steps';
import { decisionProgress, type DecisionProgress, type SavedCount } from '@/lib/decisions';
import { features, type CalculatorId } from '@/lib/features';
import type { ComponentType } from 'react';
import { calculatorTitle, PlaceholderCard } from './DecisionCard';
import { EmergencyFundCard } from './EmergencyFundCard';
import { HealthPlanCard } from './HealthPlanCard';
import { Match401kCard } from './Match401kCard';
import { SavedCountBadge } from './SavedCountBadge';
import { stepFooter } from './step-footer';
import { W4Card } from './W4Card';

/** Each calculator's card; one off in this build renders as a placeholder. */
const CARDS: Record<CalculatorId, ComponentType> = {
  emergency_fund: EmergencyFundCard,
  '401k_match': Match401kCard,
  health_plan: HealthPlanCard,
  w4: W4Card,
};

/** How to use a calculator; a placeholder has none, so its card says what it will decide. */
const LEAD =
  'Try a few choices and watch the numbers change. Save the one you want, and it goes into your plan.';

/** The chip's counts: how many are saved, of the four, and how many of those need review. */
const savedCount = ({ saved, total, needsReview }: DecisionProgress): SavedCount => ({
  saved: saved.length,
  total,
  needsReview: needsReview.length,
});

export interface DecisionStepScreenProps {
  calculator: CalculatorId;
  /** Live calculators (`features.calculators`); the rest show as After alpha. */
  calculators?: readonly CalculatorId[];
}

/**
 * One Decisions step (spec 018), with one calculator's card from
 * docs/mockup/Decisions.dc.html: its decision as the heading, its place among
 * the four, how many are saved and how many of those need review (worded as
 * the Plan words it), and Back and next through the live steps.
 * Every number on the card comes from its calculator route; none is worked
 * out here.
 */
export function DecisionStepScreen({
  calculator,
  calculators = features.calculators,
}: DecisionStepScreenProps) {
  const decisions = useDecisions().data;
  const Card = CARDS[calculator];
  const live = calculators.includes(calculator);
  // The same reading of `GET /decisions` as the side nav's done marks and each
  // card's badge, so a decision that needs review is counted as such (issue 257).
  const count = decisions && savedCount(decisionProgress(decisions));

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <PageTitle
        eyebrow={
          <>
            <span className="text-small font-semibold text-ink-3">
              Decision {stepNumber(calculator)} of {DECISION_STEPS.length}
            </span>
            {count && <SavedCountBadge count={count} />}
          </>
        }
        title={STEP_TEXT[calculator].title}
        lead={live ? LEAD : undefined}
      />
      {live ? (
        <CardErrorBoundary title={calculatorTitle(calculator)}>
          <Card />
        </CardErrorBoundary>
      ) : (
        <PlaceholderCard calculator={calculator} />
      )}
      <StepFooter {...stepFooter(calculator, calculators)} />
    </div>
  );
}
