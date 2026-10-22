import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Check your benefits summary',
  robots: { index: false },
};

/** The Confirm screen on the sample benefits summary: two plans and the 401(k) match. Development only. */
export default function SampleConfirmBenefitsPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="confirm-benefits" />
      <HydrationMarker />
    </>
  );
}
