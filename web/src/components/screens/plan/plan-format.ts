import type {
  CalendarEvent,
  Goal,
  PayFrequency,
  PlanCompleteness,
  PlanDecision,
  PlanFigure,
} from '@/lib/api/types';
import { calculatorIdOf } from '@/lib/decisions';
import type { Hue, Tone } from '@/lib/design/tone';
import { isExplained } from '@/lib/explanations';
import { formatMoney, formatNetCost, formatNumber, formatRate, formatRefund } from '@/lib/money';
import { CALCULATOR_CARDS } from '../decisions/DecisionCard';

/*
 * Words for the Plan screen (spec 016). Every figure is a field of
 * `GET /plan`, formatted as its `kind` says (a negative `net_cost` reads as an
 * amount ahead, spec 012 rule 17, and a `refund` as a refund or an amount due,
 * spec 016 rule 3); nothing is added, compared or rounded here.
 */

/** The emergency fund's months figure is null when the target is past the 10-year horizon. */
const MONTHS_TO_TARGET = 'result.months_to_target';

function expect<T>(figure: PlanFigure, ok: (value: unknown) => value is T): T {
  if (!ok(figure.value)) {
    throw new TypeError(`A ${figure.kind} figure cannot be ${JSON.stringify(figure.value)}`);
  }
  return figure.value;
}

const isNumber = (value: unknown): value is number => typeof value === 'number';
const isString = (value: unknown): value is string => typeof value === 'string';

/** A figure as text: money in dollars and cents, a percentage as the API wrote it. */
export function figureText(figure: PlanFigure): string {
  if (figure.value === null) {
    return figure.key === MONTHS_TO_TARGET ? 'Not within 10 years' : 'Not set';
  }
  switch (figure.kind) {
    case 'money':
      return formatMoney(expect(figure, isNumber));
    case 'net_cost':
      // A health plan's yearly net cost: a negative one reads as an amount ahead.
      return formatNetCost(expect(figure, isNumber));
    case 'refund':
      // The W-4's refund at tax time: a negative one is an amount due.
      return formatRefund(expect(figure, isNumber));
    case 'percent':
      return formatRate(expect(figure, isString));
    case 'count':
      return formatNumber(expect(figure, isNumber));
    case 'text':
      return expect(figure, isString);
  }
}

export type ExplanationView = PlanDecision['explanation']['status'] | 'stale' | 'unavailable';

/**
 * What to say about a decision's explanation: its status, `stale` for a
 * verified one written from figures that have changed since (spec 008 rule
 * 19b; a fallback already says it is not verified), or that none is written
 * for it.
 */
export function explanationView(decision: PlanDecision): ExplanationView {
  if (!isExplained(decision.calculator)) return 'unavailable';
  const { status, stale } = decision.explanation;
  return status === 'verified' && stale ? 'stale' : status;
}

/**
 * "3 of 4 decisions saved", with ", 3 need review" while any does (spec 016
 * rule 3a): counting the API's lists, not computing a figure.
 */
export function completenessText({ saved, missing, needs_review }: PlanCompleteness): string {
  const total = saved.length + missing.length;
  const text = `${formatNumber(saved.length)} of ${formatNumber(total)} decisions saved`;
  if (needs_review.length === 0) return text;
  const verb = needs_review.length === 1 ? 'needs' : 'need';
  return `${text}, ${formatNumber(needs_review.length)} ${verb} review`;
}

/** The completeness badge: confirmed only when the plan is whole and nothing in it needs review. */
export function completenessTone({ missing, needs_review }: PlanCompleteness): Tone {
  if (needs_review.length > 0) return 'warning';
  return missing.length === 0 ? 'confirmed' : 'neutral';
}

const GOAL_LABELS: Record<Goal['kind'], string> = {
  emergency_fund: 'Emergency fund',
  custom: 'Savings goal',
};

export const goalLabel = (kind: Goal['kind']) => GOAL_LABELS[kind];

/** The hue of the decision a calendar event came from (neutral when it has none). */
export function eventHue(event: CalendarEvent, decisions: readonly PlanDecision[]): Hue {
  const decision = decisions.find((d) => d.id === event.decision_id);
  return decision ? CALCULATOR_CARDS[calculatorIdOf(decision.calculator)].tone : 'neutral';
}

const FREQUENCIES: Record<PayFrequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Every two weeks',
  semimonthly: 'Semi-monthly',
  monthly: 'Monthly',
};

/** The pay schedule a stub shows, in words; null when the stub has none. */
export const payFrequencyLabel = (frequency: PayFrequency | null) =>
  frequency === null ? null : FREQUENCIES[frequency];
