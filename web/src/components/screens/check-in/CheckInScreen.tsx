'use client';

import Link from 'next/link';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CardErrorBoundary } from '@/components/ui/CardErrorBoundary';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorCode, apiErrorMessage } from '@/lib/api/errors';
import { useCheckIn, useCheckInNow } from '@/lib/api/hooks';
import { formatDate } from '@/lib/dates';
import { useToday } from '@/lib/periods';
import { checkInTitle, offersCheckInNow } from './checkin-format';
import { CheckInNowButton, CheckInNowStatus } from './CheckInNow';
import { DeadlinesCard } from './DeadlinesCard';
import { FindingsCard } from './FindingsCard';
import { NetWorthCard } from './NetWorthCard';
import { PlanLinesCard } from './PlanLinesCard';

const allCheckIns = (
  <Button href="/check-in" size="sm">
    All check-ins
  </Button>
);

/**
 * `/check-in/[checkInId]`, from docs/mockup/CheckIn.dc.html: what changed
 * since the plan was saved (each finding marked done, dismissed or undone),
 * the month's cash flow against the plan beside net worth and holdings (where
 * the mockup puts them), and the dates coming up. This month's open
 * check-in offers "Check in now" (the mockup's "Run again now"), which runs
 * it again and reads it back when the job finishes.
 */
export function CheckInScreen({ checkInId }: { checkInId: string }) {
  const checkIn = useCheckIn(checkInId);
  const checkInNow = useCheckInNow();
  const today = useToday();
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

  // Once started, the run's progress and outcome stay, even if the check-in completes meanwhile.
  const offered = offersCheckInNow(data, today) || checkInNow.jobId !== null;
  return (
    <>
      <PageTitle
        title={checkInTitle(data.period)}
        lead={`Compared with your plan on ${formatDate(data.updated_at)}. Each finding names the part of your plan it affects; mark it done once you have dealt with it.`}
        aside={
          offered ? (
            <div className="flex flex-wrap gap-2">
              <CheckInNowButton state={checkInNow} />
              {allCheckIns}
            </div>
          ) : (
            allCheckIns
          )
        }
      />
      {offered && <CheckInNowStatus state={checkInNow} from="check-in" />}
      <CardErrorBoundary title="What changed">
        <FindingsCard checkIn={data} />
      </CardErrorBoundary>
      <div className="flex flex-wrap items-start gap-6">
        <CardErrorBoundary title="Cash flow against the plan" className="flex-[1_1_440px]">
          <PlanLinesCard cashFlow={data.cash_flow} className="flex-[1_1_440px]" />
        </CardErrorBoundary>
        <CardErrorBoundary title="Net worth" className="flex-[1_1_320px]">
          <NetWorthCard className="flex-[1_1_320px]" />
        </CardErrorBoundary>
      </div>
      <CardErrorBoundary title="Coming up">
        <DeadlinesCard period={data.period} />
      </CardErrorBoundary>
    </>
  );
}
