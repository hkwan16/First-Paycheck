import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Plan with nothing saved',
  robots: { index: false },
};

/** The plan of someone who has saved no decision yet, for visual baselines. Development only. */
export default function SampleEmptyPlanPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="plan-empty" />
      <HydrationMarker />
    </>
  );
}
