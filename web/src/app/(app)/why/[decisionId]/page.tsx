import type { Metadata } from 'next';
import { Suspense } from 'react';
import { WhyScreen } from '@/components/screens/why/WhyScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Why this decision' };

type Params = PageProps<'/why/[decisionId]'>['params'];

/**
 * The id is request data, so it is read inside Suspense: Cache Components
 * prerenders the page's shell without it, and `next dev` reports a param read
 * outside Suspense as a navigation that cannot be instant.
 */
export default function WhyPage({ params }: { params: Params }) {
  return (
    <Suspense>
      <WhyDecision params={params} />
    </Suspense>
  );
}

async function WhyDecision({ params }: { params: Params }) {
  const { decisionId } = await params;
  return (
    <>
      <WhyScreen decisionId={decisionId} />
      <HydrationMarker />
    </>
  );
}
