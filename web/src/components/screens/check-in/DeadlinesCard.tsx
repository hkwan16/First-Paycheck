'use client';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { ListRows } from '@/components/ui/ListRows';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorMessage } from '@/lib/api/errors';
import { useCalendar } from '@/lib/api/hooks';
import { calendarParts, formatDate } from '@/lib/dates';
import { checkInWindow } from './checkin-format';

/**
 * "Coming up": the open calendar dates due by the end of the month after the
 * check-in's (`GET /calendar?to=`), soonest first. A date that passed with
 * nothing done is first, marked overdue by the API (spec 015 rule 24).
 */
export function DeadlinesCard({ period }: { period: string }) {
  const dates = checkInWindow(period);
  const calendar = useCalendar(dates);
  const events = calendar.data;

  let body;
  if (calendar.isError) {
    body = (
      <Notice tone="warning" compact role="alert">
        {apiErrorMessage(calendar.error, 'Could not load your dates. Reload to try again.')}
      </Notice>
    );
  } else if (!events) {
    body = (
      <div aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading your dates</span>
        <Skeleton block className="h-6 w-2/3" />
        <Skeleton block className="h-6 w-1/2" />
      </div>
    );
  } else if (events.length === 0) {
    body = <p className="m-0 text-small text-ink-3">Nothing is due by {formatDate(dates.to)}.</p>;
  } else {
    body = (
      <ListRows as="ul" aria-label="Upcoming dates">
        {events.map((event) => {
          const { month, day } = calendarParts(event.due_at);
          return (
            <li key={event.id} className="flex items-center gap-3.5">
              <span
                aria-hidden="true"
                className="flex w-11 flex-none flex-col items-center rounded-control bg-tile py-1 leading-tight"
              >
                <span className="text-micro font-semibold text-ink-3 uppercase">{month}</span>
                <span className="font-bold tabular-nums">{day}</span>
              </span>
              <div className="min-w-0">
                <div className="font-semibold">{event.title}</div>
                <div className="text-tiny text-ink-3">
                  {event.overdue ? 'Was due' : 'Due'} {formatDate(event.due_at)}
                </div>
                {event.overdue && (
                  <div className="mt-1">
                    <Badge tone="off">Overdue</Badge>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ListRows>
    );
  }

  return (
    <Card aria-labelledby="deadlines-title" gap={14}>
      <h2 id="deadlines-title" className="m-0">
        Coming up
      </h2>
      {body}
    </Card>
  );
}
