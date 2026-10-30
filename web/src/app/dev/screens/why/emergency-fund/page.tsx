import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Emergency fund result',
  robots: { index: false },
};

/** The Why screen for an emergency fund, which is never explained (spec 011 rule 18). Development only. */
export default function SampleWhyEmergencyFundPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="why-emergency-fund" />
      <HydrationMarker />
    </>
  );
}
