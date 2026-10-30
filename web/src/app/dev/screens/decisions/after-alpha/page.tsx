import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Decisions, After alpha',
  robots: { index: false },
};

/** A step that is off in the alpha (its placeholder, muted in the nav), for visual baselines. Development only. */
export default function SampleAfterAlphaDecisionPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="decisions-after-alpha" />
      <HydrationMarker />
    </>
  );
}
