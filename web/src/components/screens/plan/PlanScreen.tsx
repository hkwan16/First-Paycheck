'use client';

import Link from 'next/link';
import { PageTitle } from '@/components/chrome/PageTitle';
import { StepFooter } from '@/components/chrome/StepFooter';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorMessage } from '@/lib/api/errors';
import { usePlan } from '@/lib/api/hooks';
import type { PlanCompleteness } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { CALCULATOR_LABELS } from '@/lib/decisions';
import { DecisionSummary } from './DecisionSummary';
import { ExportCard } from './ExportCard';
import { GoalsCard } from './GoalsCard';
import { PaycheckCard } from './PaycheckCard';
import { PlanCalendarCard } from './PlanCalendarCard';
import { completenessText, DECISION_ANCHORS } from './plan-format';

const TITLE = 'Your plan, on one page';

/** The calculators the API lists as missing, each linked to its card on Decisions. */
function StillToDecide({ completeness }: { completeness: PlanCompleteness }) {
  if (completeness.missing.length === 0) return null;
  return (
    <Notice tone="blue" title="Still to decide:">
      <ul aria-label="Still to decide" className="m-0 inline list-none p-0">
        {completeness.missing.map((calculator, index) => (
          <li key={calculator} className="inline">
            {index > 0 && ', '}
            <Link href={DECISION_ANCHORS[calculator]}>{CALCULATOR_LABELS[calculator]}</Link>
          </li>
        ))}
      </ul>
      . Each one you save joins this plan.
    </Notice>
  );
}

/**
 * `/plan`, from docs/mockup/Plan.dc.html: every saved decision with the
 * figures its calculator produced and whether its explanation was verified,
 * the pay stub it is built on, the goals, the next 90 days, and the PDF and
 * calendar exports. One read (`GET /plan`); every number is a field of it.
 */
export function PlanScreen() {
  const plan = usePlan();
  const data = plan.data;

  if (plan.isError) {
    return (
      <>
        <PageTitle title={TITLE} />
        <Notice tone="warning" role="alert">
          {apiErrorMessage(plan.error, 'Could not load your plan. Reload to try again.')}
        </Notice>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageTitle title={TITLE} />
        <Card aria-label="Loading your plan" aria-busy="true">
          <Skeleton className="w-1/2" />
          <Skeleton className="w-2/3" />
          <Skeleton className="w-1/3" />
        </Card>
      </>
    );
  }

  if (data.decisions.length === 0) {
    return (
      <>
        <PageTitle
          title={TITLE}
          lead="Your saved decisions, with the numbers behind them and the dates when each one matters next."
        />
        <Card gap={14} aria-label="Your plan">
          <p className="m-0">No decisions saved yet.</p>
          <p className="m-0 text-small text-ink-3">
            Save a decision on any of the four calculators and it appears here, ready to print and
            to add to your calendar.
          </p>
          <div>
            <Button href="/setup/decisions" variant="primary">
              Go to decisions
            </Button>
          </div>
        </Card>
      </>
    );
  }

  const complete = data.completeness.missing.length === 0;
  return (
    <>
      <PageTitle
        title={TITLE}
        lead={`Your saved decisions with the numbers behind them, and the dates when each one matters next. As of ${formatDate(data.as_of)}.`}
        aside={
          <Badge tone={complete ? 'confirmed' : 'neutral'}>
            {completenessText(data.completeness)}
          </Badge>
        }
      />
      <StillToDecide completeness={data.completeness} />
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-6">
          <PaycheckCard payStub={data.pay_stub} />
          <ul aria-label="Saved decisions" className="m-0 flex list-none flex-col gap-6 p-0">
            {data.decisions.map((decision) => (
              <li key={decision.id}>
                <DecisionSummary decision={decision} />
              </li>
            ))}
          </ul>
          <GoalsCard goals={data.goals} />
        </div>
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
          <ExportCard />
          <PlanCalendarCard plan={data} />
        </div>
      </div>
      <StepFooter
        back={{ href: '/setup/decisions', label: 'Back to decisions' }}
        next={{ label: 'Monthly check-in', href: '/check-in' }}
      />
    </>
  );
}
