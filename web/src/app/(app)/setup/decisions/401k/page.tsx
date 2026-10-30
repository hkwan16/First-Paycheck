import type { Metadata } from 'next';
import { DecisionStepScreen } from '@/components/screens/decisions/DecisionStepScreen';
import { HydrationMarker } from '@/app/hydration-marker';
import { STEP_TEXT } from '@/lib/decision-steps';

export const metadata: Metadata = { title: STEP_TEXT['401k_match'].label };

/** Decisions, step 2 of 4 (spec 018). */
export default function K401DecisionPage() {
  return (
    <>
      <DecisionStepScreen calculator="401k_match" />
      <HydrationMarker />
    </>
  );
}
