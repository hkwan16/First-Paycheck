import type { Metadata } from 'next';
import { DecisionStepScreen } from '@/components/screens/decisions/DecisionStepScreen';
import { HydrationMarker } from '@/app/hydration-marker';
import { STEP_TEXT } from '@/lib/decision-steps';

export const metadata: Metadata = { title: STEP_TEXT['health_plan'].label };

/** Decisions, step 3 of 4 (spec 018). */
export default function HealthPlanDecisionPage() {
  return (
    <>
      <DecisionStepScreen calculator="health_plan" />
      <HydrationMarker />
    </>
  );
}
