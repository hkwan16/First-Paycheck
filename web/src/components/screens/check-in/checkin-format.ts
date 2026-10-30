import type { Route } from 'next';
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
  election_mismatch: 'Election not applied',
  goal_off_pace: 'Goal behind pace',
  recurring_new: 'New recurring charge',
  recurring_changed: 'Price changed',
  recurring_stopped: 'Charge stopped',
  pay_change: 'Pay change',
  deduction_change: 'Deduction changed',
  upcoming_deadline: 'Upcoming date',
};

export interface AffectsView {
  label: string;
  tone: Hue;
  /** Where the person acts on it: the calculators, or the Spending map. */
  href: Route;
}

const AFFECTS: Record<FindingAffects, AffectsView> = {
  k401_match: { label: '401(k) match', tone: 'plum', href: decisionKindRoute('k401_match') },
  health_plans: { label: 'Health plan', tone: 'coral', href: decisionKindRoute('health_plans') },
  emergency_fund: {
    label: 'Emergency fund',
    tone: 'teal',
    href: decisionKindRoute('emergency_fund'),
  },
  w4: { label: 'W-4', tone: 'blue', href: decisionKindRoute('w4') },
  spending: { label: 'Spending map', tone: 'blue', href: '/setup/spending' },
};

/** The part of the plan a finding affects (`payload.affects`), or null when none. */
export const affectsView = (affects: FindingAffects | null): AffectsView | null =>
  affects === null ? null : AFFECTS[affects];

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
  take_home: new Set(['under']),
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
 * request clock's UTC month (spec 015 rule 23) and leaves a completed
 * check-in as it is, so only this month's open check-in. `today` is
 * `useToday()`, null until the client knows the date.
 */
export const offersCheckInNow = (
  checkIn: Pick<CheckInDetail, 'period' | 'status'>,
  today: string | null,
) => checkIn.status === 'open' && today !== null && checkIn.period === `${today.slice(0, 7)}-01`;

const iso = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The calendar dates a check-in shows: from the first of its month to the
 * last day of the next, so the month's dates and what comes right after.
 */
export function checkInWindow(period: string): { from: string; to: string } {
  const start = parseISODate(period);
  // Day 0 of the month after next is the last day of next month.
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 2, 0));
  return { from: period, to: iso(end) };
}
