import type { Metadata } from 'next';
import { PageTitle } from '@/components/chrome/PageTitle';

export const metadata: Metadata = { title: 'Accounts and documents' };

/** Placeholder until the Accounts and documents screen lands. */
export default function LinkPage() {
  return (
    <PageTitle
      title="Link your accounts and add your documents"
      lead="This screen is on its way."
    />
  );
}
