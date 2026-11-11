import type { Route } from 'next';
import type { CheckInRun } from '@/lib/api/hooks';
import type {
  CheckInDetail,
  Finding,
  FindingAffects,
  FindingKind,
  FindingSeverity,
  PlanLine,
} from '@/lib/api/types';
import { parseISODate } from '@/lib/dates';
import type { Hue, Tone } from '@/lib/design/tone';
import { formatNumber } from '@/lib/money';
import { monthName } from '../spending/spending-format';
import { decisionKindRoute } from '@/lib/routes';

const MONTH_YEAR = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "November check-in" for the period `2026-11-01`. */
export const checkInTitle = (period: string) => `${monthName(period)} check-in`;

/** "November 2026", for the list of check-ins. */
export const checkInMonth = (period: string) => MONTH_YEAR.format(parseISODate(period));

/**
 * The API's severity (spec 015 rules 1-7) as a state: an alert is something
 * not applied (off), a warning needs a look, info is just news (blue).
 */
export function severityTone(severity: FindingSeverity): Tone {
  switch (severity) {
    case 'alert':
      return 'off';
    case 'warning':
      return 'warning';
    case 'info':
      return 'blue';
  }
}

/** A handled finding steps back to neutral, whatever its severity. */
export const findingTone = (finding: Finding): Tone =>
  finding.user_action === null ? severityTone(finding.severity) : 'neutral';

export const KIND_LABELS: Record<FindingKind, string> = {
  election_mismatch: 'Differs from your plan',
  goal_off_pace: 'Savings behind',
  recurring_new: 'New recurring charge',
  recurring_changed: 'Price changed',
  recurring_stopped: 'Charge stopped',
  pay_change: 'Paycheck changed',
  upcoming_deadline: 'Coming up',
  overdue_deadline: 'Overdue',
};

export interface AffectsView {
  /** What following the link does: "Review your 401(k)". */
  label: string;
  tone: Hue;
  /** Where the person acts on it: the calculators, or the Spending map. */
  href: Route;
}

const AFFECTS: Record<FindingAffects, AffectsView> = {
  k401_match: {
    label: 'Review your 401(k)',
    tone: 'plum',
    href: decisionKindRoute('k401_match'),
  },
  health_plans: {
    label: 'Review your health plan',
    tone: 'coral',
    href: decisionKindRoute('health_plans'),
  },
  emergency_fund: {
    label: 'Review your emergency fund',
    tone: 'teal',
    href: decisionKindRoute('emergency_fund'),
  },
  w4: { label: 'Review your W-4', tone: 'blue', href: decisionKindRoute('w4') },
  spending: { label: 'See your spending', tone: 'blue', href: '/setup/spending' },
};

/** The part of the plan a finding affects (`payload.affects`), or null when none. */
export const affectsView = (affects: FindingAffects | null): AffectsView | null =>
  affects === null ? null : AFFECTS[affects];

/** "1 new finding", "2 new findings". */
const counted = (count: number, one: string, many: string) =>
  `${formatNumber(count)} ${count === 1 ? one : many}`;

/**
 * What a run's findings did, from its counts: "2 new findings. 1 finding no
 * longer applies.", or "No new findings." when it added and took back none.
 */
function changesText({ inserted, retracted }: CheckInRun): string {
  const added = inserted > 0 ? `${counted(inserted, 'new finding', 'new findings')}.` : '';
  const gone =
    retracted > 0
      ? `${counted(retracted, 'finding no longer applies', 'findings no longer apply')}.`
      : '';
  return [added, gone].filter((part) => part !== '').join(' ') || 'No new findings.';
}

/**
 * The status line after "Check in now" (spec 015 rule 23.6): what the run
 * found, from the job's counts, never only that it ran (issue 194). On the
 * list it names the month's check-in; on the check-in the page was just read
 * again. Empty until the run ends.
 */
export function checkInNowMessage(run: CheckInRun | null, from: 'list' | 'check-in'): string {
  if (run === null) return '';
  if (run.outcome === 'skipped') {
    return 'This month’s check-in is already complete, so nothing changed.';
  }
  if (from === 'check-in') return `Checked again just now. ${changesText(run)}`;
  if (run.outcome === 'refreshed') return `Checked this month again. ${changesText(run)}`;
  return run.inserted > 0
    ? `This month’s check-in is ready with ${counted(run.inserted, 'finding', 'findings')}.`
    : 'This month’s check-in is ready. Nothing changed against your plan.';
}

/** "3 of 9 handled", from the check-in's own counts. */
export const handledText = ({
  handled_count,
  finding_count,
}: Pick<CheckInDetail, 'handled_count' | 'finding_count'>) =>
  `${formatNumber(handled_count)} of ${formatNumber(finding_count)} handled`;

/**
 * Which side of the plan needs a look, by line (spec 015 rule 19a: the API
 * says the side, the client says whether it matters). Spending more than the
 * plan does, spending less does not. Where more is not a problem (saving or
 * contributing more, more pay, more left over), only falling short does.
 * Health premiums should match the chosen plan, so either side does: a
 * premium off the plan means the election is not the one saved.
 */
const NEEDS_A_LOOK: Record<PlanLine['key'], ReadonlySet<'over' | 'under'>> = {
  income: new Set(['under']),
  essentials: new Set(['over']),
  flexible: new Set(['over']),
  other: new Set(['over']),
  savings: new Set(['under']),
  retirement: new Set(['under']),
  health: new Set(['over', 'under']),
  left_over: new Set(['under']),
};

/**
 * A line's state against its plan, from the API's `status`: on plan is
 * confirmed, a side that needs a look is a warning, a side that does not is
 * confirmed too, and a line with no plan (no status) stays neutral.
 */
export function planStatusTone(line: PlanLine): Tone {
  if (line.status === null) return 'neutral';
  if (line.status === 'on_plan') return 'confirmed';
  return NEEDS_A_LOOK[line.key].has(line.status) ? 'warning' : 'confirmed';
}

const STATUS_WORDS: Record<NonNullable<PlanLine['status']>, string> = {
  on_plan: 'On plan',
  over: 'Over plan',
  under: 'Under plan',
};

/** The API's status in words ("Under plan"), or null for a line with no plan. */
export const planStatusText = (status: PlanLine['status']): string | null =>
  status === null ? null : STATUS_WORDS[status];

/**
 * How far a line's bar fills: its actual as a share of its plan. This is
 * geometry, like the Sankey's scale: it sizes a mark and is never shown,
 * compared or rounded. Whether a line is on plan is the API's to say
 * (`status`, read by `planStatusTone`). Null
 * when there is no plan to measure against.
 */
export function planBarValue(line: PlanLine): number | null {
  if (line.plan_cents === null || line.plan_cents <= 0) return null;
  return (line.actual_cents / line.plan_cents) * 100;
}

/**
 * Whether a check-in offers "Check in now": `POST /check-ins` runs the
 * person's month (spec 015 rule 23, spec 019 rule 9) and leaves a completed
 * check-in as it is, so only this month's open check-in. `today` is
 * `useToday()`, the person's today from `GET /profile`, null until it answers.
 */
export const offersCheckInNow = (
  checkIn: Pick<CheckInDetail, 'period' | 'status'>,
  today: string | null,
) => checkIn.status === 'open' && today !== null && checkIn.period === `${today.slice(0, 7)}-01`;

const iso = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The calendar dates this month's check-in shows: every open date (spec 015
 * rule 24) due by the last day of next month. There is no start, so a date
 * that passed with nothing done, in this month or an earlier one, is listed
 * as overdue rather than left out (issue 233).
 */
export function checkInWindow(period: string): { to: string } {
  const start = parseISODate(period);
  // Day 0 of the month after next is the last day of next month.
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 2, 0));
  return { to: iso(end) };
}
