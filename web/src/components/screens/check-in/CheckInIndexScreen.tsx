'use client';

import Link from 'next/link';
import { PageTitle } from '@/components/chrome/PageTitle';
import { TrendIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { IconTile } from '@/components/ui/IconTile';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorMessage } from '@/lib/api/errors';
import { useCheckIns } from '@/lib/api/hooks';
import type { CheckInSummary } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { formatNumber } from '@/lib/money';
import { checkInRoute } from '@/lib/routes';
import { checkInMonth, handledText } from './checkin-format';

function statusText(checkIn: CheckInSummary): string {
  return checkIn.status === 'completed' && checkIn.completed_at
    ? `Completed ${formatDate(checkIn.completed_at)}`
    : 'Open';
}

/** `/check-in`: every monthly check-in, newest first, each with how much of it is handled. */
export function CheckInIndexScreen() {
  const checkIns = useCheckIns();
  const items = checkIns.data;

  let body;
  if (checkIns.isError) {
    body = (
      <Notice tone="warning" role="alert">
        {apiErrorMessage(checkIns.error, 'Could not load your check-ins. Reload to try again.')}
      </Notice>
    );
  } else if (!items) {
    body = (
      <Card aria-label="Loading your check-ins" aria-busy="true">
        <Skeleton className="w-1/2" />
        <Skeleton className="w-2/3" />
      </Card>
    );
  } else if (items.length === 0) {
    body = (
      <Card gap={14} aria-label="Check-ins">
        <p className="m-0">
          No check-in yet. The first one runs at the start of next month, and again whenever a sync
          brings in new pay stubs or transactions that month.
        </p>
      </Card>
    );
  } else {
    body = (
      <Card padding={20} gap={0}>
        <ul aria-label="Check-ins" className="m-0 list-none p-0">
          {items.map((checkIn) => (
            <li
              key={checkIn.id}
              className="flex flex-wrap items-center gap-3 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0"
            >
              <IconTile tone="blue" muted={checkIn.status === 'completed'}>
                <TrendIcon size={18} />
              </IconTile>
              <div className="min-w-0 flex-1">
                <Link href={checkInRoute(checkIn.id)} className="font-semibold">
                  {checkInMonth(checkIn.period)}
                </Link>
                <div className="text-small text-ink-3">
                  {formatNumber(checkIn.finding_count)}{' '}
                  {checkIn.finding_count === 1 ? 'finding' : 'findings'} · {statusText(checkIn)}
                </div>
              </div>
              {checkIn.finding_count > 0 && (
                <Badge tone={checkIn.status === 'completed' ? 'confirmed' : 'neutral'}>
                  <span className="tabular-nums">{handledText(checkIn)}</span>
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  return (
    <>
      <PageTitle
        title="Monthly check-ins"
        lead="Each month, and whenever new data arrives, your pay stubs and transactions are compared with the plan you saved."
      />
      {body}
    </>
  );
}
