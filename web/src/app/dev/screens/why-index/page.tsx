import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Sample: Why each decision', robots: { index: false } };

/** The index of saved decisions, on the sample 401(k) decision, for visual baselines. Development only. */
export default function SampleWhyIndexPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="why-index" />
      <HydrationMarker />
    </>
  );
}
