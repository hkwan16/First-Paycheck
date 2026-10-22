import type { ReactNode } from 'react';
import type {
  DeductionChangePayload,
  ElectionMismatchPayload,
  Finding,
  GoalOffPacePayload,
  PayChangePayload,
  RecurringCadence,
  RecurringPayload,
  UpcomingDeadlinePayload,
} from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { formatMoney, formatNumber, formatRate } from '@/lib/money';

/*
 * What a finding says, one small component per payload kind (spec 015,
 * "Outputs"). Every number is a payload field, formatted: the finders and
 * calc/checkin.py worked them out, signs included.
 */

const money = (cents: number) => formatMoney(cents);
const signed = (cents: number) => formatMoney(cents, { signed: true });
const day = (date: string) => formatDate(date);

const PER: Record<RecurringCadence, string> = {
  weekly: 'a week',
  monthly: 'a month',
  yearly: 'a year',
};

const CADENCE: Record<RecurringCadence, string> = {
  weekly: 'weekly',
  monthly: 'monthly',
  yearly: 'yearly',
};

function Text({ titleId, title, body }: { titleId: string; title: ReactNode; body: ReactNode }) {
  return (
    <>
      <div id={titleId} className="font-semibold">
        {title}
      </div>
      <div className="text-small text-ink-3">{body}</div>
    </>
  );
}

interface KindProps<P> {
  payload: P;
  titleId: string;
}

export function ElectionMismatchText({ payload: p, titleId }: KindProps<ElectionMismatchPayload>) {
  const tail = `a paycheck: a difference of ${signed(p.difference_cents)}.`;
  if (p.calculator === 'health_plans') {
    const plan = p.plan_name ? `the ${p.plan_name} plan` : 'the plan you chose';
    return (
      <Text
        titleId={titleId}
        title={`Your health premium does not match ${plan}.`}
        body={`Your ${day(p.pay_date)} pay stub took ${money(p.actual_cents)} for medical coverage. The plan you chose costs ${money(p.expected_cents)} ${tail}`}
      />
    );
  }
  const rates = p.actual_pct != null && p.elected_pct != null;
  return (
    <Text
      titleId={titleId}
      title={
        rates
          ? `Your 401(k) contribution is ${formatRate(p.actual_pct!)}, not the ${formatRate(p.elected_pct!)} you chose.`
          : 'Your 401(k) contribution does not match your election.'
      }
      body={`Your ${day(p.pay_date)} pay stub withheld ${money(p.actual_cents)}. Your election works out to ${money(p.expected_cents)} ${tail}`}
    />
  );
}

export function GoalOffPaceText({ payload: p, titleId }: KindProps<GoalOffPacePayload>) {
  const goal = p.affects === 'emergency_fund' ? 'Your emergency fund' : 'Your savings goal';
  const months = `${formatNumber(p.months_elapsed)} ${p.months_elapsed === 1 ? 'month' : 'months'}`;
  return (
    <Text
      titleId={titleId}
      title={`${goal} is ${money(p.shortfall_cents)} behind pace.`}
      body={`On pace it would hold ${money(p.expected_cents)} by now: ${money(p.start_balance_cents)} on ${day(p.started_on)} plus ${money(p.monthly_contribution_cents)} a month for ${months}. It held ${money(p.balance_cents)} on ${day(p.balance_as_of)}, toward a ${money(p.target_amount_cents)} target.`}
    />
  );
}

export function RecurringText({ payload: p, titleId }: KindProps<RecurringPayload>) {
  switch (p.kind) {
    case 'recurring_new':
      return (
        <Text
          titleId={titleId}
          title={`${p.merchant}, ${money(p.typical_amount_cents)}, looks ${CADENCE[p.cadence]}.`}
          body={`First seen ${day(p.first_seen)}, last charged ${day(p.last_seen)}.`}
        />
      );
    case 'recurring_changed':
      return (
        <Text
          titleId={titleId}
          title={`${p.merchant} now charges ${money(p.typical_amount_cents)} ${PER[p.cadence]}.`}
          body={
            p.previous_amount_cents != null && p.change_cents != null
              ? `It was ${money(p.previous_amount_cents)}, a change of ${signed(p.change_cents)}.`
              : 'The earlier price is not on record.'
          }
        />
      );
    case 'recurring_stopped':
      return (
        <Text
          titleId={titleId}
          title={`${p.merchant} has stopped charging.`}
          body={`Last charged ${money(p.typical_amount_cents)} on ${day(p.last_seen)}.${
            p.user_status === 'cancelled' ? ' That matches the cancellation you marked.' : ''
          }`}
        />
      );
  }
}

export function PayChangeText({ payload: p, titleId }: KindProps<PayChangePayload>) {
  return (
    <Text
      titleId={titleId}
      title={`Your gross pay changed by ${signed(p.gross_change_cents)} a paycheck.`}
      body={`${money(p.gross_cents)} on ${day(p.pay_date)}, from ${money(p.previous_gross_cents)} on ${day(p.previous_pay_date)}. Take-home went from ${money(p.previous_net_cents)} to ${money(p.net_cents)} (${signed(p.net_change_cents)}).`}
    />
  );
}

export function DeductionChangeText({ payload: p, titleId }: KindProps<DeductionChangePayload>) {
  return (
    <Text
      titleId={titleId}
      title={`${p.label} went from ${money(p.previous_cents)} to ${money(p.amount_cents)}.`}
      body={`A change of ${signed(p.change_cents)} between the ${day(p.previous_pay_date)} and ${day(p.pay_date)} pay stubs.`}
    />
  );
}

function dueIn(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${formatNumber(days)} days`;
}

export function UpcomingDeadlineText({ payload: p, titleId }: KindProps<UpcomingDeadlinePayload>) {
  return (
    <Text
      titleId={titleId}
      title={p.title}
      body={`Due ${day(p.due_at)}, ${dueIn(p.days_until)}.`}
    />
  );
}

/** A finding's title (with `titleId`, which names its row) and its details. */
export function FindingText({ finding, titleId }: { finding: Finding; titleId: string }) {
  const { payload } = finding;
  switch (payload.kind) {
    case 'election_mismatch':
      return <ElectionMismatchText payload={payload} titleId={titleId} />;
    case 'goal_off_pace':
      return <GoalOffPaceText payload={payload} titleId={titleId} />;
    case 'recurring_new':
    case 'recurring_changed':
    case 'recurring_stopped':
      return <RecurringText payload={payload} titleId={titleId} />;
    case 'pay_change':
      return <PayChangeText payload={payload} titleId={titleId} />;
    case 'deduction_change':
      return <DeductionChangeText payload={payload} titleId={titleId} />;
    case 'upcoming_deadline':
      return <UpcomingDeadlineText payload={payload} titleId={titleId} />;
  }
}
