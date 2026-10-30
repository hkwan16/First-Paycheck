import type { Metadata } from 'next';
import { DecisionStepScreen } from '@/components/screens/decisions/DecisionStepScreen';
import { HydrationMarker } from '@/app/hydration-marker';
import { STEP_TEXT } from '@/lib/decision-steps';

export const metadata: Metadata = { title: STEP_TEXT['w4'].label };

/** Decisions, step 4 of 4 (spec 018). */
export default function W4DecisionPage() {
  return (
    <>
      <DecisionStepScreen calculator="w4" />
      <HydrationMarker />
    </>
  );
}
