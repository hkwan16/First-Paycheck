import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConfirmScreen } from '@/components/screens/confirm/ConfirmScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Confirm pay stub' };

type Params = PageProps<'/setup/confirm/[documentId]'>['params'];

/**
 * The id is request data, so it is read inside Suspense: Cache Components
 * prerenders the page's shell without it, and `next dev` reports a param read
 * outside Suspense as a navigation that cannot be instant.
 */
export default function ConfirmPage({ params }: { params: Params }) {
  return (
    <Suspense>
      <ConfirmDocument params={params} />
    </Suspense>
  );
}

async function ConfirmDocument({ params }: { params: Params }) {
  const { documentId } = await params;
  return (
    <>
      <ConfirmScreen documentId={documentId} />
      <HydrationMarker />
    </>
  );
}
