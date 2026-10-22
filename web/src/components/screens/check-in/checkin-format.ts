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
  k401_match: { label: '401(k) match', tone: 'plum', href: '/setup/decisions' },
  health_plans: { label: 'Health plan', tone: 'coral', href: '/setup/decisions' },
  emergency_fund: { label: 'Emergency fund', tone: 'teal', href: '/setup/decisions' },
  w4: { label: 'W-4', tone: 'blue', href: '/setup/decisions' },
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

const LINE_TONES: Record<PlanLine['key'], Hue> = {
  take_home: 'plum',
  essentials: 'blue',
  flexible: 'coral',
  other: 'neutral',
  savings: 'teal',
  retirement: 'plum',
  health: 'coral',
  left_over: 'neutral',
};

/** The hue of what a cash-flow line is (pay, essentials, flexible, savings, 401(k), health). */
export const planLineTone = (key: PlanLine['key']): Hue => LINE_TONES[key];

/**
 * How far a line's bar fills: its actual as a share of its plan. This is
 * geometry, like the Sankey's scale: it sizes a mark and is never shown,
 * compared or rounded. Whether a line is on plan is the API's to say. Null
 * when there is no plan to measure against.
 */
export function planBarValue(line: PlanLine): number | null {
  if (line.plan_cents === null || line.plan_cents <= 0) return null;
  return (line.actual_cents / line.plan_cents) * 100;
}

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
