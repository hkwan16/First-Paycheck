import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Monthly check-in, completed',
  robots: { index: false },
};

/** The November check-in with every finding handled, for visual baselines. Development only. */
export default function SampleCompletedCheckInPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="check-in-complete" />
      <HydrationMarker />
    </>
  );
}
