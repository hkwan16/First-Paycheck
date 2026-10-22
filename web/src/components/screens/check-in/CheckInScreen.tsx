'use client';

import Link from 'next/link';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorCode, apiErrorMessage } from '@/lib/api/errors';
import { useCheckIn } from '@/lib/api/hooks';
import { formatDate } from '@/lib/dates';
import { checkInTitle } from './checkin-format';
import { DeadlinesCard } from './DeadlinesCard';
import { FindingsCard } from './FindingsCard';
import { PlanLinesCard } from './PlanLinesCard';

const allCheckIns = (
  <Button href="/check-in" size="sm">
    All check-ins
  </Button>
);

/**
 * `/check-in/[checkInId]`, from docs/mockup/CheckIn.dc.html: what changed
 * since the plan was saved (each finding marked done, dismissed or undone),
 * the month's cash flow against the plan, and the dates coming up.
 */
export function CheckInScreen({ checkInId }: { checkInId: string }) {
  const checkIn = useCheckIn(checkInId);
  const data = checkIn.data;

  if (checkIn.isError) {
    const missing = apiErrorCode(checkIn.error) === 'not_found';
    return (
      <>
        <PageTitle title={missing ? 'Check-in not found' : 'Monthly check-in'} />
        <Notice tone="warning" role="alert">
          {missing
            ? 'This check-in is not one of yours, or it no longer exists. '
            : apiErrorMessage(
                checkIn.error,
                'Could not load this check-in. Reload to try again.',
              )}{' '}
          {missing && <Link href="/check-in">See all check-ins</Link>}
        </Notice>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageTitle title="Monthly check-in" />
        <Card aria-label="Loading the check-in" aria-busy="true">
          <Skeleton className="w-1/2" />
          <Skeleton className="w-2/3" />
          <Skeleton className="w-1/3" />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageTitle
        title={checkInTitle(data.period)}
        lead={`Compared with your plan on ${formatDate(data.updated_at)}. Each finding names the part of your plan it affects; mark it done once you have dealt with it.`}
        aside={allCheckIns}
      />
      <FindingsCard checkIn={data} />
      <div className="flex flex-wrap items-start gap-6">
        <PlanLinesCard cashFlow={data.cash_flow} className="flex-[1_1_440px]" />
      </div>
      <DeadlinesCard period={data.period} />
    </>
  );
}
