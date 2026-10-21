import type { Metadata } from 'next';
import { ConfirmScreen } from '@/components/screens/confirm/ConfirmScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Confirm pay stub' };

export default async function ConfirmPage({ params }: PageProps<'/setup/confirm/[documentId]'>) {
  const { documentId } = await params;
  return (
    <>
      <ConfirmScreen documentId={documentId} />
      <HydrationMarker />
    </>
  );
}
