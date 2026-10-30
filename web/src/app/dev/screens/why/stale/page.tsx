import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Explanation out of date',
  robots: { index: false },
};

/** The Why screen when a verified explanation is out of date (spec 008 rule 19b). Development only. */
export default function SampleWhyStalePage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="why-stale" />
      <HydrationMarker />
    </>
  );
}
