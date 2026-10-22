import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Sample: Plan and calendar', robots: { index: false } };

/** The sample user's plan with every decision saved, for visual baselines. Development only. */
export default function SamplePlanPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="plan" />
      <HydrationMarker />
    </>
  );
}
