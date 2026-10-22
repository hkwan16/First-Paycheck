import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Pay stub not read',
  robots: { index: false },
};

/** The Confirm screen for a stub whose file could not be opened. Development only. */
export default function SampleConfirmFailedPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="confirm-failed" />
      <HydrationMarker />
    </>
  );
}
