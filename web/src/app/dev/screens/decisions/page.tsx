import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Sample: Decisions', robots: { index: false } };

/** The Decisions screen on the sample 401(k) decision, for visual baselines. Development only. */
export default function SampleDecisionsPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="decisions" />
      <HydrationMarker />
    </>
  );
}
