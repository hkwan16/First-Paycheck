import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Accounts and documents',
  robots: { index: false },
};

/** The Link screen on the mockup's sample data, for visual baselines. Development only. */
export default function SampleLinkPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="link" />
      <HydrationMarker />
    </>
  );
}
