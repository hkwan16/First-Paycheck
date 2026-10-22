'use client';

import { PageTitle } from '@/components/chrome/PageTitle';
import { StepFooter } from '@/components/chrome/StepFooter';
import { Badge } from '@/components/ui/Badge';
import { Num } from '@/components/ui/Money';
import { useDecisions } from '@/lib/api/hooks';
import { CALCULATORS, features, type CalculatorId } from '@/lib/features';
import type { ComponentType } from 'react';
import { PlaceholderCard } from './DecisionCard';
import { EmergencyFundCard } from './EmergencyFundCard';
import { HealthPlanCard } from './HealthPlanCard';
import { Match401kCard } from './Match401kCard';
import { W4Card } from './W4Card';

/** The mockup's card order: emergency fund, 401(k), health plan, W-4. */
const ORDER: readonly CalculatorId[] = ['emergency_fund', '401k_match', 'health_plan', 'w4'];

/** Each calculator's card; one off in this build renders as a placeholder. */
const CARDS: Record<CalculatorId, ComponentType> = {
  emergency_fund: EmergencyFundCard,
  '401k_match': Match401kCard,
  health_plan: HealthPlanCard,
  w4: W4Card,
};

export interface DecisionsScreenProps {
  /** Live calculators (`features.calculators`); the rest show as After alpha. */
  calculators?: readonly CalculatorId[];
}

/**
 * Setup step 4, from docs/mockup/Decisions.dc.html: one card per calculator,
 * each saving a versioned decision. Every number on a card comes from its
 * calculator route; none is worked out here.
 */
export function DecisionsScreen({ calculators = features.calculators }: DecisionsScreenProps) {
  const decisions = useDecisions().data;
  const live = new Set(calculators);

  return (
    <>
      <PageTitle
        title="Four decisions for your first month"
        lead="Move the controls to try what-ifs. Every number comes from the calculator, not the AI. Saving keeps a versioned record and adds it to your plan."
        aside={
          decisions && (
            <Badge>
              <Num value={decisions.items.length} /> of {CALCULATORS.length} saved
            </Badge>
          )
        }
      />
      <div className="grid grid-cols-2 items-start gap-6 max-wide:grid-cols-1">
        {ORDER.map((calculator) => {
          const Card = CARDS[calculator];
          return live.has(calculator) ? (
            <Card key={calculator} />
          ) : (
            <PlaceholderCard key={calculator} calculator={calculator} />
          );
        })}
      </div>
      <StepFooter
        back={{ href: '/setup/spending' }}
        next={{ label: 'See your plan', href: '/plan' }}
      />
    </>
  );
}
