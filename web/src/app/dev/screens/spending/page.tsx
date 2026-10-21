import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Sample: Spending map', robots: { index: false } };

/** The Spending screen on the mockup's sample data, for visual baselines. Development only. */
export default function SampleSpendingPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="spending" />
      <HydrationMarker />
    </>
  );
}
