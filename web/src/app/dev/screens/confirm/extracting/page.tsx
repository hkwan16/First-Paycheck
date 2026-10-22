import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Reading pay stub',
  robots: { index: false },
};

/** The Confirm screen while the sample stub is being read. Development only. */
export default function SampleConfirmExtractingPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="confirm-extracting" />
      <HydrationMarker />
    </>
  );
}
