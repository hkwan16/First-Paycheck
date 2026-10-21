import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Explanation fallback',
  robots: { index: false },
};

/** The Why screen when the explanation could not be verified. Development only. */
export default function SampleWhyFallbackPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="why-fallback" />
      <HydrationMarker />
    </>
  );
}
