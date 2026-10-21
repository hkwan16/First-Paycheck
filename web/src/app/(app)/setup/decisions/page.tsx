import type { Metadata } from 'next';
import { DecisionsScreen } from '@/components/screens/decisions/DecisionsScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Decisions' };

export default function DecisionsPage() {
  return (
    <>
      <DecisionsScreen />
      <HydrationMarker />
    </>
  );
}
