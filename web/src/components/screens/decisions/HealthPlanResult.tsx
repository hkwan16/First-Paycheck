import { useId, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tile } from '@/components/ui/Tile';
import { apiErrorMessage } from '@/lib/api/errors';
import type { CalcState } from '@/lib/api/hooks';
import type {
  HealthcareUsage,
  HealthPlanOption,
  HealthPlansInput,
  HealthPlansResult,
} from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { toneText } from '@/lib/design/tone';
import { formatRate } from '@/lib/money';
import {
  costAt,
  costText,
  hdhpNotice,
  headline,
  HEALTH_TERM_ORDER,
  HEALTH_TERMS,
  hsaEffect,
  pairText,
  PLAN_KIND_LABELS,
  usageLabel,
  USAGES,
} from './health-plan-format';

export const HEALTH_CALC_PATH = '/calc/health-plans';

export type Scenarios = Record<HealthcareUsage, number>;

export interface PlanResultProps {
  inputs: HealthPlansInput | null;
  plans: readonly HealthPlanOption[] | null;
  calc: CalcState<typeof HEALTH_CALC_PATH>;
  usage: HealthcareUsage;
  scenarios: Scenarios;
  selected: number | null;
  taxYear: number;
}

/** The result panel: every cost, saving and break-even is a field of the calculator's result. */
export function PlanResult({
  inputs,
  plans,
  calc,
  usage,
  scenarios,
  selected,
  taxYear,
}: PlanResultProps) {
  const result = calc.data;
  let content: ReactNode;
  if (inputs === null) {
    content = (
      <p className="m-0 text-small text-ink-3">
        Enter your own HSA contribution, or 0, to see the comparison.
      </p>
    );
  } else if (calc.isError) {
    content = (
      <Notice tone="warning" compact role="alert">
        {apiErrorMessage(calc.error, 'Could not work out your numbers. Try again in a moment.')}
      </Notice>
    );
  } else if (result && plans && result.plans.length === plans.length) {
    content = (
      <Comparison
        result={result}
        plans={plans}
        usage={usage}
        scenarios={scenarios}
        selected={selected}
        taxYear={taxYear}
      />
    );
  } else {
    content = (
      <div className="flex flex-col gap-2.5">
        <Skeleton className="w-3/4" />
        <Skeleton className="w-full" />
        <Skeleton className="w-full" />
        <span className="sr-only">Working out your numbers.</span>
      </div>
    );
  }
  return (
    <Tile
      tone="coral"
      role="group"
      aria-label="Your numbers"
      aria-busy={(inputs !== null && calc.isBusy) || undefined}
    >
      {content}
    </Tile>
  );
}

interface ComparisonProps {
  result: HealthPlansResult;
  plans: readonly HealthPlanOption[];
  usage: HealthcareUsage;
  scenarios: Scenarios;
  selected: number | null;
  taxYear: number;
}

function Comparison({ result, plans, usage, scenarios, selected, taxYear }: ComparisonProps) {
  const names = result.plans.map((plan) => plan.name);
  const cell = 'border-t border-line px-2 py-1.5 text-right tabular-nums';
  const rowHead = 'border-t border-line py-1.5 pr-2 text-left font-normal text-ink-3';
  const money = (cents: number) => <Money cents={cents} decimals={0} />;
  // A net cost: the API's sign, a negative one written as an amount ahead (spec 012 rule 17).
  const cost = (cents: number) => <span className="tabular-nums">{costText(cents)}</span>;
  const row = (label: string, values: ReactNode[], strong = false) => (
    <tr key={label} className={cn(strong && 'font-semibold')}>
      <th scope="row" className={cn(rowHead, strong && 'font-semibold text-ink')}>
        {label}
      </th>
      {values.map((value, index) => (
        <td key={index} className={cell}>
          {value}
        </td>
      ))}
    </tr>
  );
  const effects = result.plans.map((plan) => hsaEffect(plan, result)).filter(Boolean);
  const notices = result.plans.map((plan) => hdhpNotice(plan, result, taxYear)).filter(Boolean);

  return (
    <>
      <div className={cn('text-headline font-bold', toneText.coral)} aria-live="polite">
        {headline(result, usage)}
      </div>
      <PlanTerms />
      <div
        role="region"
        aria-label="Plan comparison, scrolls sideways"
        tabIndex={0}
        className="-mx-1 overflow-x-auto px-1"
      >
        <table className="w-full min-w-[420px] border-collapse text-small">
          <caption className="sr-only">Expected yearly cost by plan</caption>
          <thead>
            <tr>
              <td />
              {result.plans.map((plan, index) => (
                <th key={index} scope="col" className="px-2 pb-1.5 text-right align-bottom">
                  <span className="block font-semibold">{plan.name}</span>
                  <span className="block text-tiny font-normal text-ink-3">
                    {PLAN_KIND_LABELS[plan.kind]}
                  </span>
                  {index === result.recommended_index && (
                    <Badge tone="coral" className="mt-1">
                      Cheapest at {usage} use
                    </Badge>
                  )}
                  {index === selected && (
                    <Badge tone="blue" className="mt-1">
                      Your choice
                    </Badge>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row(
              'Premium per year',
              result.plans.map((plan) => money(plan.annual_premium_cents)),
            )}
            {row(
              'Deductible',
              plans.map((plan) => money(plan.deductible_cents)),
            )}
            {row(
              'Coinsurance',
              plans.map((plan) => formatRate(plan.coinsurance_pct)),
            )}
            {row(
              'Out-of-pocket maximum',
              plans.map((plan) => money(plan.oop_max_cents)),
            )}
            {row(
              'Employer HSA money',
              result.plans.map((plan) =>
                plan.employer_hsa_cents === 0 ? 'None' : money(plan.employer_hsa_cents),
              ),
            )}
            {row(
              'Your HSA tax savings',
              result.plans.map((plan) =>
                plan.hsa_eligible ? money(plan.hsa_tax_savings_cents) : 'No HSA',
              ),
            )}
            {USAGES.map((u) =>
              row(
                usageLabel(u, scenarios[u], { row: true }),
                result.plans.map((plan) => cost(costAt(plan, u))),
                u === usage,
              ),
            )}
            {row(
              'Worst case',
              result.plans.map((plan) => cost(plan.worst_case_cents)),
            )}
          </tbody>
        </table>
      </div>
      {result.pairs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="m-0 text-small font-semibold">Where the cheaper plan changes</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-small text-ink-2">
            {result.pairs.map((pair) => (
              <li key={`${pair.plan_a_index}-${pair.plan_b_index}`}>
                <strong className="font-semibold text-ink">
                  {names[pair.plan_a_index]} or {names[pair.plan_b_index]}.
                </strong>{' '}
                {pairText(pair, names)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {effects.map((text) => (
        <p key={text} className="m-0 text-small text-ink-2">
          {text}
        </p>
      ))}
      {notices.map((text) => (
        <Notice key={text} tone="warning" compact>
          {text}
        </Notice>
      ))}
    </>
  );
}

/**
 * What each plan term means (spec 012 rule 19, issue 207): a native
 * disclosure, so the keyboard and screen readers open it, above the table
 * whose rows use the terms.
 */
function PlanTerms() {
  const id = useId();
  return (
    <details aria-labelledby={id} className="rounded-control bg-surface px-3.5 py-2.5 text-small">
      <summary id={id} className="min-h-[24px] cursor-pointer font-semibold text-ink-2">
        What these terms mean
      </summary>
      <dl className="m-0 mt-2.5 flex flex-col gap-2">
        {HEALTH_TERM_ORDER.map((key) => (
          <div key={key}>
            <dt className="font-semibold text-ink">{HEALTH_TERMS[key].term}</dt>
            <dd className="m-0 text-ink-2">{HEALTH_TERMS[key].meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
