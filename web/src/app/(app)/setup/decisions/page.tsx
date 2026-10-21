import type { Metadata } from 'next';
import { PageTitle } from '@/components/chrome/PageTitle';

export const metadata: Metadata = { title: 'Decisions' };

/** Placeholder until the Decisions screen lands. */
export default function DecisionsPage() {
  return (
    <PageTitle title="Four decisions for your first month" lead="This screen is on its way." />
  );
}
