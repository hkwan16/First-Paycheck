import type { ReactNode } from 'react';
import { Money } from '@/components/ui/Money';
import type {
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

const CADENCE: Record<RecurringCadence, string> = {
  weekly: 'weekly',
  monthly: 'monthly',
  yearly: 'yearly',
};

const PER: Record<RecurringCadence, string> = {
  weekly: 'a week',
  monthly: 'a month',
  yearly: 'a year',
};

function Text({
  titleId,
  title,
  body,
  children,
}: {
  titleId: string;
  title: ReactNode;
  body: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <div id={titleId} className="font-semibold">
        {title}
      </div>
      <div className="text-small text-ink-3">{body}</div>
      {children}
    </>
  );
}

interface KindProps<P> {
  payload: P;
  titleId: string;
}

export function ElectionMismatchText({ payload: p, titleId }: KindProps<ElectionMismatchPayload>) {
  const stub = `Your ${day(p.pay_date)} pay stub`;
  const difference = `a difference of ${signed(p.difference_cents)}`;
  if (p.calculator === 'health_plans') {
    const plan = p.plan_name ? `the ${p.plan_name} plan` : 'the plan you chose';
    return (
      <Text
        titleId={titleId}
        title={`Your health premium differs from ${plan}.`}
        body={`${stub} took ${money(p.actual_cents)} for health coverage. The plan you chose costs ${money(p.expected_cents)} a paycheck, ${difference}. Check your enrollment with HR.`}
      />
    );
  }
  const rates = p.actual_pct != null && p.elected_pct != null;
  return (
    <Text
      titleId={titleId}
      title={
        rates
          ? `Your pay stub puts ${formatRate(p.actual_pct!)} in your 401(k). You chose ${formatRate(p.elected_pct!)}.`
          : 'Your pay stub’s 401(k) amount differs from what you chose.'
      }
      body={`${stub} put ${money(p.actual_cents)} in your 401(k). At the rate you chose it would be ${money(p.expected_cents)} a paycheck, ${difference}. Ask payroll to update it.`}
    />
  );
}

export function GoalOffPaceText({ payload: p, titleId }: KindProps<GoalOffPacePayload>) {
  const goal = p.affects === 'emergency_fund' ? 'Your emergency fund' : 'Your savings goal';
  const months = `${formatNumber(p.months_elapsed)} ${p.months_elapsed === 1 ? 'month' : 'months'}`;
  return (
    <Text
      titleId={titleId}
      title={`${goal} is ${money(p.shortfall_cents)} behind.`}
      body={`To be on track it would hold ${money(p.expected_cents)} by now, ${money(p.start_balance_cents)} on ${day(p.started_on)} plus ${money(p.monthly_contribution_cents)} a month for ${months}. It held ${money(p.balance_cents)} on ${day(p.balance_as_of)}, toward your ${money(p.target_amount_cents)} goal.`}
    />
  );
}

export function RecurringText({ payload: p, titleId }: KindProps<RecurringPayload>) {
  switch (p.kind) {
    case 'recurring_new':
      return (
        <Text
          titleId={titleId}
          title={`${p.merchant} looks like a ${CADENCE[p.cadence]} charge of ${money(p.typical_amount_cents)}.`}
          body={`First charged ${day(p.first_seen)}, most recently ${day(p.last_seen)}.`}
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
              : 'We have no earlier price for it.'
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

function PayLine({
  label,
  before,
  after,
  change,
}: {
  label: string;
  before: number;
  after: number;
  change: number;
}) {
  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-1 pr-3 text-left font-normal">
        {label}
      </th>
      <td className="py-1 pl-3 text-right">
        <Money cents={before} />
      </td>
      <td className="py-1 pl-3 text-right">
        <Money cents={after} />
      </td>
      <td className="py-1 pl-3 text-right text-ink-2">
        <Money cents={change} signed />
      </td>
    </tr>
  );
}

/**
 * One paycheck against the one before it (spec 015 rules 5-6, issue 202):
 * take-home in words, then gross pay and each deduction line that moved, in
 * the order the API lists them.
 */
export function PayChangeText({ payload: p, titleId }: KindProps<PayChangePayload>) {
  return (
    <Text
      titleId={titleId}
      title={`Your ${day(p.pay_date)} paycheck changed.`}
      body={`Take-home pay went from ${money(p.previous_net_cents)} to ${money(p.net_cents)} (${signed(p.net_change_cents)}) since your ${day(p.previous_pay_date)} pay stub.`}
    >
      <table className="mt-1 w-full max-w-md border-collapse text-small tabular-nums">
        <caption className="sr-only">
          Your {day(p.previous_pay_date)} and {day(p.pay_date)} pay stubs
        </caption>
        <thead>
          <tr className="text-tiny font-semibold text-ink-3">
            <th scope="col" className="pb-1 text-left font-semibold">
              <span className="sr-only">Line</span>
            </th>
            <th scope="col" className="pb-1 pl-3 text-right font-semibold">
              {formatDate(p.previous_pay_date, 'short')}
            </th>
            <th scope="col" className="pb-1 pl-3 text-right font-semibold">
              {formatDate(p.pay_date, 'short')}
            </th>
            <th scope="col" className="pb-1 pl-3 text-right font-semibold">
              Change
            </th>
          </tr>
        </thead>
        <tbody>
          <PayLine
            label="Gross pay"
            before={p.previous_gross_cents}
            after={p.gross_cents}
            change={p.gross_change_cents}
          />
          {p.deductions.map((line) => (
            <PayLine
              key={line.line}
              label={line.label}
              before={line.previous_cents}
              after={line.amount_cents}
              change={line.change_cents}
            />
          ))}
        </tbody>
      </table>
    </Text>
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
    case 'upcoming_deadline':
      return <UpcomingDeadlineText payload={payload} titleId={titleId} />;
  }
}
