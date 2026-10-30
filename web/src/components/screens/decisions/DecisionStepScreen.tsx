'use client';

import { PageTitle } from '@/components/chrome/PageTitle';
import { StepFooter } from '@/components/chrome/StepFooter';
import { Badge } from '@/components/ui/Badge';
import { CardErrorBoundary } from '@/components/ui/CardErrorBoundary';
import { Num } from '@/components/ui/Money';
import { useDecisions } from '@/lib/api/hooks';
import { DECISION_STEPS, STEP_TEXT, stepNumber } from '@/lib/decision-steps';
import { CALCULATORS, features, type CalculatorId } from '@/lib/features';
import type { ComponentType } from 'react';
import { calculatorTitle, PlaceholderCard } from './DecisionCard';
import { EmergencyFundCard } from './EmergencyFundCard';
import { HealthPlanCard } from './HealthPlanCard';
import { Match401kCard } from './Match401kCard';
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
  'Move the controls to try what-ifs. Every number comes from the calculator, not the AI. Saving keeps a versioned record and adds it to your plan.';

export interface DecisionStepScreenProps {
  calculator: CalculatorId;
  /** Live calculators (`features.calculators`); the rest show as After alpha. */
  calculators?: readonly CalculatorId[];
}

/**
 * One Decisions step (spec 018), with one calculator's card from
 * docs/mockup/Decisions.dc.html: its decision as the heading, its place among
 * the four, how many are saved, and Back and next through the live steps.
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

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <PageTitle
        eyebrow={
          <>
            <span className="text-small font-semibold text-ink-3">
              Decision {stepNumber(calculator)} of {DECISION_STEPS.length}
            </span>
            {decisions && (
              <Badge>
                <Num value={decisions.items.length} /> of {CALCULATORS.length} saved
              </Badge>
            )}
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
