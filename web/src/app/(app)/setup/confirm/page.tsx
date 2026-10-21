import type { Metadata } from 'next';
import { ConfirmIndexScreen } from '@/components/screens/confirm/ConfirmIndexScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Confirm pay stub' };

/** The Confirm step without a document id: finds the pay stub to review. */
export default function ConfirmIndexPage() {
  return (
    <>
      <ConfirmIndexScreen />
      <HydrationMarker />
    </>
  );
}
