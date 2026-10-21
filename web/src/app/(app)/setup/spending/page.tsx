import type { Metadata } from 'next';
import { SpendingScreen } from '@/components/screens/spending/SpendingScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Spending map' };

export default function SpendingPage() {
  return (
    <>
      <SpendingScreen />
      <HydrationMarker />
    </>
  );
}
