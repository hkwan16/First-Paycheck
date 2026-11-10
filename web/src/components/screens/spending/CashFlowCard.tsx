'use client';

import { useMemo } from 'react';
import {
  CashFlowSankey,
  DEFAULT_HEADINGS,
  flowScale,
  FlowStack,
  layoutCashFlow,
  legendFor,
  MIN_HOST_W,
  STACK_BELOW,
  useContainerWidth,
  type FlowNode,
} from '@/components/sankey';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { Skeleton } from '@/components/ui/Skeleton';
import { Swatch } from '@/components/ui/Swatch';
import { periodFilters, useAccounts, useTransactions } from '@/lib/api/hooks';
import type { CashFlow } from '@/lib/api/types';
import { formatMoney } from '@/lib/money';
import { FlowDetails } from './FlowDetails';
import { monthName, payStubsText, periodText } from './spending-format';

/**
 * Where each half of the diagram comes from (spec 010 rule 5a, issue 200):
 * the pay stubs give gross pay to take-home, the deposits give the spending,
 * so the summary's income and the diagram's gross pay read as two things.
 */
function Sources({ flow }: { flow: CashFlow }) {
  const deposits = <Money cents={flow.spending.income_cents} />;
  return flow.withholding.paycheck_count > 0 ? (
    <>
      Gross pay to take-home comes from {payStubsText(flow.withholding.paycheck_count)}. Spending
      comes from the {deposits} deposited in your accounts, which can include pay with no confirmed
      stub.
    </>
  ) : (
    <>
      Spending comes from the {deposits} of income deposited in your accounts. Confirm a pay stub to
      see what comes out of your pay before payday.
    </>
  );
}

/** Nothing to draw: no confirmed pay stub and no transaction in the period. */
const isEmpty = (flow: CashFlow) =>
  flow.withholding.paycheck_count === 0 && flow.spending.transaction_count === 0;

/** "about $14": the scale, in whole dollars once it is a dollar or more. */
const scaleText = (centsPerPx: number) =>
  formatMoney(centsPerPx, { decimals: centsPerPx >= 100 ? 0 : 2 });

export interface CashFlowCardProps {
  /** `GET /cashflow` for the period; undefined while it loads. */
  flow: CashFlow | undefined;
  /** Another period is on its way; the last one stays on screen. */
  updating?: boolean;
}

/**
 * The mockup's "Where each dollar of October pay went": the cash-flow
 * Sankey (components/sankey) at the card's width, or stacked bars under
 * 640 px. Every amount is from `GET /cashflow`; the scale badge is computed
 * from the diagram's target height.
 */
export function CashFlowCard({ flow, updating }: CashFlowCardProps) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  // The period's rows for the category popovers: the list the Transactions card reads.
  const { transactions } = useTransactions(flow ? periodFilters(flow) : null);
  const accounts = useAccounts().data;
  const masks = useMemo(
    () => new Map((accounts ?? []).map((a) => [a.id, a.mask] as const)),
    [accounts],
  );

  const month = flow ? monthName(flow.start) : null;
  const stacked = width < STACK_BELOW;
  const scale = flow && !stacked ? flowScale(flow) : null;
  // Only the groups this period draws (spec 010 rule 5c); the colors and
  // amounts do not depend on the width.
  const legend = useMemo(() => (flow ? legendFor(layoutCashFlow(flow, MIN_HOST_W)) : []), [flow]);
  const headings = useMemo(
    () =>
      [
        month ? `Pay stubs, ${month}` : DEFAULT_HEADINGS[0],
        DEFAULT_HEADINGS[1],
        DEFAULT_HEADINGS[2],
        DEFAULT_HEADINGS[3],
      ] as const,
    [month],
  );

  let body;
  if (!flow) {
    body = (
      <div aria-busy="true">
        <span className="sr-only">Loading the cash flow</span>
        <Skeleton block className="h-72 w-full rounded-tile" />
      </div>
    );
  } else if (isEmpty(flow)) {
    body = (
      <p className="m-0 text-small text-ink-3">
        Nothing to draw for {periodText(flow.start, flow.end)} yet. Confirm a pay stub and link the
        account your pay lands in.
      </p>
    );
  } else if (stacked) {
    body = <FlowStack flow={flow} />;
  } else {
    body = (
      <CashFlowSankey
        flow={flow}
        width={width}
        headings={headings}
        renderDetails={(node: FlowNode) => (
          <FlowDetails node={node} flow={flow} transactions={transactions} masks={masks} />
        )}
      />
    );
  }

  return (
    <Card aria-labelledby="flow-title" gap={12} aria-busy={updating || undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="flow-title" className="m-0">
            {month ? `Where each dollar of ${month} pay went` : 'Where each dollar of pay went'}
          </h2>
          {flow && !isEmpty(flow) && (
            <p className="m-0 text-small text-ink-3">
              <Sources flow={flow} />
            </p>
          )}
        </div>
        {scale && <Badge>Scale: 1 px is about {scaleText(scale.centsPerPx)}</Badge>}
      </div>
      <div ref={ref}>{body}</div>
      {flow && !isEmpty(flow) && legend.length > 0 && (
        <ul aria-label="Legend" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0">
          {legend.map(({ color, label }) => (
            <li key={label} className="inline-flex items-center gap-1.5 text-small text-ink-2">
              <Swatch color={color} />
              {label}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
