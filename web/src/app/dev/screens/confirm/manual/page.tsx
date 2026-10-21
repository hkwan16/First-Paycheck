import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Enter pay stub fields',
  robots: { index: false },
};

/** The Confirm screen in manual entry, on the sample stub's redacted lines. Development only. */
export default function SampleConfirmManualPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="confirm-manual" />
      <HydrationMarker />
    </>
  );
}
