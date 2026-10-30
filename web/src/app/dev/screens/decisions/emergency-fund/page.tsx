import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Decisions, Emergency fund',
  robots: { index: false },
};

/** The emergency fund step on the sample saved decisions, for visual baselines. Development only. */
export default function SampleEmergencyFundDecisionPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="decisions-emergency-fund" />
      <HydrationMarker />
    </>
  );
}
