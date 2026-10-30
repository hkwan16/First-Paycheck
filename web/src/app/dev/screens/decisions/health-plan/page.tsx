import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Decisions, Health plan',
  robots: { index: false },
};

/** The health plan step on the sample saved decisions, for visual baselines. Development only. */
export default function SampleHealthPlanDecisionPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="decisions-health-plan" />
      <HydrationMarker />
    </>
  );
}
