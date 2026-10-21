import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Sample: Confirm pay stub', robots: { index: false } };

/** The Confirm screen on the mockup's sample stub, for visual baselines. Development only. */
export default function SampleConfirmPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="confirm" />
      <HydrationMarker />
    </>
  );
}
