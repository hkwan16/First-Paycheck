import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Bar } from '@/components/ui/Bar';
import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import type { CheckInCashFlow, PlanLine } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/money';
import { ledgerNote, monthName, payStubsText, periodText } from '../spending/spending-format';
import { planBarValue, planStatusText, planStatusTone } from './checkin-format';

function Line({ line }: { line: PlanLine }) {
  const bar = planBarValue(line);
  const total = line.key === 'left_over';
  const tone = planStatusTone(line);
  const status = planStatusText(line.status);
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
            tone={tone}
            label={`${line.label} against plan`}
            valueText={`${formatMoney(line.actual_cents)} of ${formatMoney(line.plan_cents)} planned`}
          />
        )}
      </th>
      <td className={cn('py-2.5 pl-3 text-right', total && 'font-semibold')}>
        {/* The status sits beside the amount, and wraps under it in a narrow card. */}
        <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <Money cents={line.actual_cents} />
          {status !== null && <Badge tone={tone}>{status}</Badge>}
        </span>
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
 * has reached so far, colored by the API's status for it (rule 19a) and the
 * status said in words beside the actual: the client only decides which side
 * of the plan matters for the line (`planStatusTone`), never the side itself.
 */
export function PlanLinesCard({
  cashFlow,
  className,
}: {
  cashFlow: CheckInCashFlow;
  className?: string;
}) {
  const flow = cashFlow.cash_flow;
  const ledgers = ledgerNote(flow.spending.ledger_rows_skipped);
  return (
    <Card aria-labelledby="plan-lines-title" gap={14} className={cn('@container', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="plan-lines-title" className="m-0">
          {monthName(flow.start)} cash flow against the plan
        </h2>
        <span className="text-tiny text-ink-3">
          {periodText(flow.start, flow.end)} · {payStubsText(flow.withholding.paycheck_count)}
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
      {ledgers && <p className="m-0 text-tiny text-ink-3">{ledgers}</p>}
    </Card>
  );
}
