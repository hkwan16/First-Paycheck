import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CheckInScreen } from '@/components/screens/check-in/CheckInScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Monthly check-in' };

type Params = PageProps<'/check-in/[checkInId]'>['params'];

/**
 * The id is request data, so it is read inside Suspense: Cache Components
 * prerenders the page's shell without it, and `next dev` reports a param read
 * outside Suspense as a navigation that cannot be instant.
 */
export default function CheckInPage({ params }: { params: Params }) {
  return (
    <Suspense>
      <CheckIn params={params} />
    </Suspense>
  );
}

async function CheckIn({ params }: { params: Params }) {
  const { checkInId } = await params;
  return (
    <>
      <CheckInScreen checkInId={checkInId} />
      <HydrationMarker />
    </>
  );
}
