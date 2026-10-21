import type { Metadata } from 'next';
import { PageTitle } from '@/components/chrome/PageTitle';

export const metadata: Metadata = { title: 'Why this decision' };

/** Placeholder until the Why this decision screen lands. */
export default function WhyPage() {
  return <PageTitle title="Why this decision" lead="This screen is on its way." />;
}
