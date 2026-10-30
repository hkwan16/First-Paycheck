import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Decisions, W-4',
  robots: { index: false },
};

/** The W-4 step on the sample saved decisions, for visual baselines. Development only. */
export default function SampleW4DecisionPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="decisions-w4" />
      <HydrationMarker />
    </>
  );
}
