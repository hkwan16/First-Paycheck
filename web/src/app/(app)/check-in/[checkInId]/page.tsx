import type { Metadata } from 'next';
import { PageTitle } from '@/components/chrome/PageTitle';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Monthly check-in' };

/** Placeholder until the Monthly check-in screen lands. */
export default function CheckInPage() {
  return (
    <>
      <PageTitle title="Monthly check-in" lead="This screen is on its way." />
      <HydrationMarker />
    </>
  );
}
