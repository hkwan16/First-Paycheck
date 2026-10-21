import type { Metadata } from 'next';
import { LinkScreen } from '@/components/screens/link/LinkScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Accounts and documents' };

export default function LinkPage() {
  return (
    <>
      <LinkScreen />
      <HydrationMarker />
    </>
  );
}
