import type {
  CalculatorKind,
  CalendarEvent,
  Goal,
  PayFrequency,
  PlanCompleteness,
  PlanDecision,
  PlanFigure,
} from '@/lib/api/types';
import { calculatorIdOf } from '@/lib/decisions';
import type { Hue } from '@/lib/design/tone';
import { formatMoney, formatNumber, formatRate } from '@/lib/money';
import { CALCULATOR_CARDS } from '../decisions/DecisionCard';

/*
 * Words for the Plan screen (spec 016). Every figure is a field of
 * `GET /plan`, formatted as its `kind` says; nothing is added, compared or
 * rounded here.
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
    case 'percent':
      return formatRate(expect(figure, isString));
    case 'count':
      return formatNumber(expect(figure, isNumber));
    case 'text':
      return expect(figure, isString);
  }
}

/** Calculators the API can explain; an emergency fund has no IRS source (spec 011). */
const EXPLAINED: ReadonlySet<CalculatorKind> = new Set(['k401_match', 'health_plans', 'w4']);

export type ExplanationView = PlanDecision['explanation']['status'] | 'unavailable';

/** What to say about a decision's explanation: its status, or that none is written for it. */
export const explanationView = (decision: PlanDecision): ExplanationView =>
  EXPLAINED.has(decision.calculator) ? decision.explanation.status : 'unavailable';

/** "3 of 4 decisions saved": counting the API's two lists, not computing a figure. */
export function completenessText({ saved, missing }: PlanCompleteness): string {
  const total = saved.length + missing.length;
  return `${formatNumber(saved.length)} of ${formatNumber(total)} decisions saved`;
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
