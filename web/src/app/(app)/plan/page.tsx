import type { Metadata } from 'next';
import { PageTitle } from '@/components/chrome/PageTitle';

export const metadata: Metadata = { title: 'Plan and calendar' };

/** Placeholder until the Plan and calendar screen lands. */
export default function PlanPage() {
  return <PageTitle title="Your plan, on one page" lead="This screen is on its way." />;
}
