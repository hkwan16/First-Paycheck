import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Pay stub confirmed',
  robots: { index: false },
};

/** The Confirm screen for a stub already confirmed. Development only. */
export default function SampleConfirmConfirmedPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="confirm-confirmed" />
      <HydrationMarker />
    </>
  );
}
