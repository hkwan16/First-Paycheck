import Link from 'next/link';
import { Bar } from '@/components/ui/Bar';
import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import type { CheckInCashFlow, PlanLine } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { formatMoney, formatNumber } from '@/lib/money';
import { monthName, periodText } from '../spending/spending-format';
import { planBarValue, planLineTone } from './checkin-format';

function Line({ line }: { line: PlanLine }) {
  const bar = planBarValue(line);
  const total = line.key === 'left_over';
  return (
    <tr className="border-t border-line align-top first:border-t-0">
      <th
        scope="row"
        className={cn('py-2.5 pr-3 text-left', total ? 'font-semibold' : 'font-normal')}
      >
        <span className="block">{line.label}</span>
        {bar !== null && line.plan_cents !== null && (
          <Bar
            className="mt-2"
            height={6}
            value={bar}
            tone={planLineTone(line.key)}
            label={`${line.label} against plan`}
            valueText={`${formatMoney(line.actual_cents)} of ${formatMoney(line.plan_cents)} planned`}
          />
        )}
      </th>
      <td className={cn('py-2.5 pl-3 text-right', total && 'font-semibold')}>
        <Money cents={line.actual_cents} />
      </td>
      <td className="py-2.5 pl-3 text-right">
        {line.plan_cents === null ? (
          <span className="text-tiny text-ink-3">No target</span>
        ) : (
          <Money cents={line.plan_cents} />
        )}
        {line.difference_cents !== null && (
          // In a narrow card the difference sits under the plan instead of in its own column.
          <span className="block text-tiny text-ink-3 @md:hidden">
            <Money cents={line.difference_cents} signed />
          </span>
        )}
      </td>
      <td className="py-2.5 pl-3 text-right text-ink-2 @max-md:hidden">
        {line.difference_cents !== null && <Money cents={line.difference_cents} signed />}
      </td>
    </tr>
  );
}

/**
 * The month's cash flow against the plan (spec 015 rule 19): each line's
 * actual beside the target its decision set, and the difference, all as the
 * API worked them out. A line's bar shows how much of its target the month
 * has reached so far, in the line's own hue: whether that is on plan is not
 * something the client decides.
 */
export function PlanLinesCard({
  cashFlow,
  className,
}: {
  cashFlow: CheckInCashFlow;
  className?: string;
}) {
  const flow = cashFlow.cash_flow;
  const paychecks = flow.withholding.paycheck_count;
  return (
    <Card aria-labelledby="plan-lines-title" gap={14} className={cn('@container', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="plan-lines-title" className="m-0">
          {monthName(flow.start)} cash flow against the plan
        </h2>
        <span className="text-tiny text-ink-3">
          {periodText(flow.start, flow.end)} · {formatNumber(paychecks)}{' '}
          {paychecks === 1 ? 'paycheck' : 'paychecks'}
        </span>
      </div>
      <table className="w-full border-collapse text-control tabular-nums">
        <thead>
          <tr className="text-tiny font-semibold tracking-[0.03em] text-ink-3 uppercase">
            <th scope="col" className="pb-1.5 text-left font-semibold">
              Line
            </th>
            <th scope="col" className="pb-1.5 pl-3 text-right font-semibold">
              Actual
            </th>
            <th scope="col" className="pb-1.5 pl-3 text-right font-semibold">
              Plan
            </th>
            <th scope="col" className="pb-1.5 pl-3 text-right font-semibold @max-md:hidden">
              Difference
            </th>
          </tr>
        </thead>
        <tbody>
          {cashFlow.plan.map((line) => (
            <Line key={line.key} line={line} />
          ))}
        </tbody>
      </table>
      <p className="m-0 text-tiny text-ink-3">
        Targets come from your saved decisions; a line without one has no decision behind it yet. A
        month still under way is counted to date.{' '}
        <Link href="/setup/spending">Open the Spending map</Link>
      </p>
    </Card>
  );
}
