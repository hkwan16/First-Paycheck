import type { Metadata } from 'next';
import { PlanScreen } from '@/components/screens/plan/PlanScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Plan and calendar' };

/** Your plan: every saved decision, its figures, the next 90 days and the exports. */
export default function PlanPage() {
  return (
    <>
      <PlanScreen />
      <HydrationMarker />
    </>
  );
}
