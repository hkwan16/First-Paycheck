import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Account menu',
  robots: { index: false },
};

/**
 * The Link screen with the header's account menu, where an account is
 * deleted. Development only.
 */
export default function SampleAccountPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="account" />
      <HydrationMarker />
    </>
  );
}
