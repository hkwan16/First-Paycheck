import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Replaced decision',
  robots: { index: false },
};

/** The Why screen for a decision a newer version replaced (spec 008 rule 19c). Development only. */
export default function SampleWhyReplacedPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="why-replaced" />
      <HydrationMarker />
    </>
  );
}
