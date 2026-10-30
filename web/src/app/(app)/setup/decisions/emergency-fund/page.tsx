import type { Metadata } from 'next';
import { DecisionStepScreen } from '@/components/screens/decisions/DecisionStepScreen';
import { HydrationMarker } from '@/app/hydration-marker';
import { STEP_TEXT } from '@/lib/decision-steps';

export const metadata: Metadata = { title: STEP_TEXT['emergency_fund'].label };

/** Decisions, step 1 of 4 (spec 018). */
export default function EmergencyFundDecisionPage() {
  return (
    <>
      <DecisionStepScreen calculator="emergency_fund" />
      <HydrationMarker />
    </>
  );
}
