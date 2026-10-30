import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Decisions, 401(k) match',
  robots: { index: false },
};

/** The 401(k) step on the sample saved decisions, for visual baselines. Development only. */
export default function SampleK401DecisionPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="decisions-401k" />
      <HydrationMarker />
    </>
  );
}
