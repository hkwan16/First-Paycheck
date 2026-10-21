import type { Metadata } from 'next';
import { PageTitle } from '@/components/chrome/PageTitle';

export const metadata: Metadata = { title: 'Confirm pay stub' };

/** Placeholder until the Confirm pay stub screen lands. */
export default function ConfirmPage() {
  return (
    <PageTitle title="Check what we read from your pay stub" lead="This screen is on its way." />
  );
}
