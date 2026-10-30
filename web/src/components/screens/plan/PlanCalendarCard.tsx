import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { ListRows } from '@/components/ui/ListRows';
import type { Plan } from '@/lib/api/types';
import { calendarParts, formatDate } from '@/lib/dates';
import { CALCULATOR_LABELS } from '@/lib/decisions';
import { toneText } from '@/lib/design/tone';
import { cn } from '@/lib/cn';
import { eventHue } from './plan-format';
import { decisionKindRoute } from '@/lib/routes';

/**
 * "Next 90 days", from the mockup's decision calendar: the plan's upcoming
 * events through `calendar_through` (spec 016 rule 6), in the API's order,
 * each marked with the decision it came from.
 */
export function PlanCalendarCard({ plan }: { plan: Plan }) {
  const through = formatDate(plan.calendar_through);
  return (
    <Card aria-labelledby="plan-calendar-title" gap={14}>
      <div>
        <h2 id="plan-calendar-title" className="m-0">
          Next 90 days
        </h2>
        <p className="m-0 text-small text-ink-3">Through {through}</p>
      </div>
      {plan.calendar.length === 0 ? (
        <p className="m-0 text-small text-ink-3">Nothing is due by {through}.</p>
      ) : (
        <ListRows as="ul" aria-label="Upcoming dates">
          {plan.calendar.map((event) => {
            const { month, day } = calendarParts(event.due_at);
            const hue = eventHue(event, plan.decisions);
            const decision = plan.decisions.find((d) => d.id === event.decision_id);
            return (
              <li key={event.id} className="flex items-start gap-3.5">
                <span
                  aria-hidden="true"
                  className="flex w-11 flex-none flex-col items-center rounded-control bg-tile py-1 leading-tight"
                >
                  <span className="text-micro font-semibold text-ink-3 uppercase">{month}</span>
                  <span className={cn('font-bold tabular-nums', toneText[hue])}>{day}</span>
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="font-semibold">{event.title}</div>
                  <div className="text-tiny text-ink-3">Due {formatDate(event.due_at)}</div>
                  {decision && (
                    <div>
                      <Badge tone={hue} href={decisionKindRoute(decision.calculator)}>
                        {CALCULATOR_LABELS[decision.calculator]}
                      </Badge>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ListRows>
      )}
    </Card>
  );
}
