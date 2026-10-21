import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { KitGallery } from '@/components/screens/dev-kit/KitGallery';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Component kit', robots: { index: false } };

/** The design system gallery. Development only: production builds return 404. */
export default function KitPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <KitGallery />
      <HydrationMarker />
    </>
  );
}
