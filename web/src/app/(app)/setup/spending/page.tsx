import type { Metadata } from 'next';
import { PageTitle } from '@/components/chrome/PageTitle';

export const metadata: Metadata = { title: 'Spending map' };

/** Placeholder until the Spending map screen lands. */
export default function SpendingPage() {
  return <PageTitle title="Where your money went" lead="This screen is on its way." />;
}
