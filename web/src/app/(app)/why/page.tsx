import type { Metadata } from 'next';
import { WhyIndexScreen } from '@/components/screens/why/WhyIndexScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Why each decision' };

export default function WhyIndexPage() {
  return (
    <>
      <WhyIndexScreen />
      <HydrationMarker />
    </>
  );
}
