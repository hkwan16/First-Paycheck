import { Badge } from '@/components/ui/Badge';
import { Bar } from '@/components/ui/Bar';
import { Card } from '@/components/ui/Card';
import { ListRows } from '@/components/ui/ListRows';
import { Money } from '@/components/ui/Money';
import type { Goal } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { formatRate } from '@/lib/money';
import { goalStatusBadge } from '../decisions/emergency-fund-format';
import { goalLabel } from './plan-format';

/** One goal: its status, what it aims for, when, and how far the linked account has it. */
function GoalRow({ goal }: { goal: Goal }) {
  const label = goalLabel(goal.kind);
  const badge = goalStatusBadge(goal.status);
  let when: string | null = null;
  if (goal.status === 'reached' && goal.reached_at) when = `Reached ${formatDate(goal.reached_at)}`;
  // A paused goal gets no contributions, so its projected date does not hold (issue 166).
  else if (goal.status !== 'paused' && goal.target_date) {
    when = `By ${formatDate(goal.target_date)}`;
  }

  return (
    <li aria-label={label} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{label}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className="m-0 text-small">
        <Money cents={goal.monthly_contribution_cents} /> a month toward{' '}
        <Money cents={goal.target_amount_cents} />
        {when && <span className="text-ink-3"> · {when}</span>}
      </p>
      {goal.progress_pct !== null && (
        <>
          <p className="m-0 text-tiny text-ink-3">
            {goal.current_balance_cents !== null && (
              <>
                <Money cents={goal.current_balance_cents} /> saved,{' '}
              </>
            )}
            {formatRate(goal.progress_pct)} of the target
          </p>
          <Bar
            tone={goal.status === 'reached' ? 'confirmed' : 'teal'}
            value={Number(goal.progress_pct)}
            label={`${label} progress`}
            valueText={`${formatRate(goal.progress_pct)} of the target`}
            height={6}
          />
        </>
      )}
    </li>
  );
}

/** The goals saved decisions made (`GET /goals`, as the plan carries them), oldest first. */
export function GoalsCard({ goals }: { goals: readonly Goal[] }) {
  return (
    <Card aria-labelledby="goals-title" gap={14}>
      <h2 id="goals-title" className="m-0">
        Goals
      </h2>
      {goals.length === 0 ? (
        <p className="m-0 text-small text-ink-3">
          No goals yet. Saving an emergency fund decision sets one.
        </p>
      ) : (
        <ListRows as="ul" aria-label="Your goals">
          {goals.map((goal) => (
            <GoalRow key={goal.id} goal={goal} />
          ))}
        </ListRows>
      )}
    </Card>
  );
}
