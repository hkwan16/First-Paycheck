import type { Metadata } from 'next';
import { WhyScreen } from '@/components/screens/why/WhyScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Why this decision' };

export default async function WhyPage({ params }: PageProps<'/why/[decisionId]'>) {
  const { decisionId } = await params;
  return (
    <>
      <WhyScreen decisionId={decisionId} />
      <HydrationMarker />
    </>
  );
}
