import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleScreen } from '@/components/screens/dev-screens/SampleScreen';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = {
  title: 'Sample: Read a pay stub again',
  robots: { index: false },
};

/**
 * The Confirm screen in manual entry for a stub uploaded while the AI was
 * unavailable, which offers Read again (spec 004 rules 32-37). Development only.
 */
export default function SampleConfirmUnreadPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <SampleScreen screen="confirm-unread" />
      <HydrationMarker />
    </>
  );
}
