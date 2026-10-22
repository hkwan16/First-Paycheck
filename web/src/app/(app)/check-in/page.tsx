import type { Metadata } from 'next';
import { CheckInIndexScreen } from '@/components/screens/check-in/CheckInIndexScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Monthly check-ins' };

export default function CheckInIndexPage() {
  return (
    <>
      <CheckInIndexScreen />
      <HydrationMarker />
    </>
  );
}
