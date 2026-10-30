'use client';

import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Seg } from '@/components/ui/Seg';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tile } from '@/components/ui/Tile';
import { apiErrorMessage } from '@/lib/api/errors';
import {
  useBenefitsPlans,
  useCalc,
  useCalendar,
  useDecisions,
  usePayStubs,
  useProfile,
  useSaveDecision,
  type CalcState,
} from '@/lib/api/hooks';
import type {
  HealthcareUsage,
  HealthPlanOption,
  HealthPlansInput,
  HealthPlansResult,
} from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { useFocusHandoff } from '@/lib/focus-handoff';
import { formatDate } from '@/lib/dates';
import {
  asHealthPlansInputs,
  currentDecision,
  decisionSaveState,
  payPeriodsFor,
} from '@/lib/decisions';
import { toneText } from '@/lib/design/tone';
import { formatRate } from '@/lib/money';
import { whyRoute } from '@/lib/routes';
import { AmountField } from './AmountField';
import { CALCULATOR_CARDS, DecisionCard, SaveButton } from './DecisionCard';
import {
  amountText,
  calendarNote,
  readAmount,
  saveBadgeTone,
  saveErrorText,
} from './decision-format';
import {
  choiceAmong,
  costAt,
  costText,
  hdhpNotice,
  headline,
  hsaEffect,
  pairText,
  PLAN_KIND_LABELS,
  plansFromBenefits,
  USAGE_DEFAULTS,
  usageLabel,
  USAGES,
} from './health-plan-format';
import { payFrequencyOf } from './plan-details';
import { PlanOptionsForm } from './PlanOptionsForm';

const CALC_PATH = '/calc/health-plans';

type Scenarios = Record<HealthcareUsage, number>;
type Source = 'benefits' | 'saved' | 'typed';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The health plan card, from docs/mockup/Decisions.dc.html. The plans come
 * from the newest confirmed benefits summary (`GET /benefits-plans`), the
 * saved decision, or a table typed by hand; salary, filing status and pay
 * schedule from the profile and the tax year from the confirmed pay stub.
 * The person picks the usage they expect, their own HSA contribution and the
 * plan they will enroll in. Every cost, saving and break-even is the
 * calculator's (`POST /calc/health-plans` through `useCalc`); saving keeps the
 * chosen plan as a version and puts the enrollment deadline on the calendar.
 */
export function HealthPlanCard() {
  const id = useId();
  const profile = useProfile();
  const payStubs = usePayStubs();
  const decisions = useDecisions();
  const benefits = useBenefitsPlans();
  const calendar = useCalendar();
  const current = currentDecision(decisions.data, 'health_plans');
  const saved = current ? asHealthPlansInputs(current.inputs) : null;
  const save = useSaveDecision('health_plans');
  const fromBenefits = plansFromBenefits(benefits.data);

  // What the person has set; until they do, the saved decision's choices.
  const [override, setOverride] = useState<{ plans: HealthPlanOption[]; source: Source } | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  // The plan table and the comparison take each other's place (issue 167).
  const focus = useFocusHandoff<'plans-form' | 'edit-plans' | 'usage'>();
  const [usage, setUsage] = useState<HealthcareUsage | null>(null);
  const [hsa, setHsa] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null | undefined>(undefined);
  const [deadline, setDeadline] = useState<string | null>(null);

  const { plans, source } = override ??
    (saved && { plans: saved.plans, source: 'saved' as const }) ??
    (fromBenefits && { plans: fromBenefits.plans, source: 'benefits' as const }) ?? {
      plans: null,
      source: null,
    };

  const scenarios: Scenarios = {
    low: saved?.usage_low_cents ?? USAGE_DEFAULTS.low,
    medium: saved?.usage_medium_cents ?? USAGE_DEFAULTS.medium,
    high: saved?.usage_high_cents ?? USAGE_DEFAULTS.high,
  };
  const usageValue =
    usage ?? saved?.expected_usage ?? profile.data?.expected_healthcare_usage ?? 'medium';
  const hsaValue = hsa ?? amountText(saved?.employee_hsa_cents ?? 0);
  const hsaRead = readAmount(hsaValue, { example: '1,000.00' });
  const selectedValue = selected !== undefined ? selected : (saved?.selected_plan_index ?? null);
  const deadlineValue =
    deadline ?? (saved ? (saved.enrollment_deadline ?? '') : (fromBenefits?.deadline ?? ''));

  const loaded =
    profile.data !== undefined &&
    payStubs.data !== undefined &&
    decisions.data !== undefined &&
    benefits.data !== undefined;
  const payStub = payStubs.data?.[0];
  const periods = loaded ? payPeriodsFor(payFrequencyOf(profile.data, payStub)) : null;
  const salary = profile.data?.salary_cents ?? null;
  const filing = profile.data?.filing_status ?? null;
  const showForm = editing || plans === null;

  // The comparison is on screen: everything it reads is there and no plan table is open.
  const comparing =
    loaded &&
    !showForm &&
    plans !== null &&
    payStub !== undefined &&
    periods !== null &&
    salary !== null &&
    filing !== null;
  const inputs: HealthPlansInput | null =
    comparing && hsaRead.cents !== null
      ? {
          plans,
          pay_periods_per_year: periods,
          salary_cents: salary,
          filing_status: filing,
          tax_year: payStub.tax_year,
          employee_hsa_cents: hsaRead.cents,
          expected_usage: usageValue,
          usage_low_cents: scenarios.low,
          usage_medium_cents: scenarios.medium,
          usage_high_cents: scenarios.high,
          selected_plan_index: selectedValue,
          enrollment_deadline: deadlineValue || null,
        }
      : null;
  const calc = useCalc(CALC_PATH, inputs);
  // On the comparison, the badge compares what is set; elsewhere, only whether a version exists.
  const state = decisionSaveState(current, comparing ? inputs : (current?.inputs ?? null));
  const edit = (apply: () => void) => {
    apply();
    if (save.isError) save.reset();
  };
  const applyPlans = (next: HealthPlanOption[], from: Source) =>
    edit(() => {
      // Back to the button that opened the table, else on to the comparison's first control.
      focus.moveTo(editing ? 'edit-plans' : 'usage');
      setOverride({ plans: next, source: from });
      // The chosen plan stays chosen while the new plans still offer it (issue 168).
      setSelected(choiceAmong(plans, selectedValue, next));
      setEditing(false);
    });

  const event = calendar.data?.find(
    (e) => e.kind === 'enrollment_deadline' && current && e.decision_id === current.id,
  );

  let body: ReactNode;
  const failed = profile.error ?? payStubs.error ?? decisions.error ?? benefits.error;
  if (failed) {
    body = (
      <Notice tone="warning" compact role="alert">
        {apiErrorMessage(failed, 'Could not load your plans. Reload the page to try again.')}
      </Notice>
    );
  } else if (!loaded) {
    body = (
      <div className="flex flex-col gap-3">
        <Skeleton className="w-full" />
        <Skeleton className="w-3/4" />
        <span className="sr-only">Loading your health plans.</span>
      </div>
    );
  } else if (!payStub || periods === null) {
    body = (
      <>
        <Notice tone="blue" compact icon={null}>
          The comparison reads your pay schedule and tax year from a confirmed pay stub.
        </Notice>
        <div>
          <Button href="/setup/confirm" variant="primary">
            Confirm your pay stub
          </Button>
        </div>
      </>
    );
  } else if (salary === null || filing === null) {
    body = (
      <Notice tone="blue" compact icon={null}>
        The comparison needs your salary and filing status for the tax an HSA saves. Add them with
        Change plan details on the 401(k) card.
      </Notice>
    );
  } else if (showForm) {
    body = (
      <>
        {plans === null && (
          <p className="m-0 text-small text-ink-3">
            No benefits summary is confirmed, so the plans to compare are typed here. Confirming a
            benefits summary fills them in.
          </p>
        )}
        <PlanOptionsForm
          ref={focus.target('plans-form')}
          initial={plans}
          onCompare={(next) => applyPlans(next, 'typed')}
          onCancel={
            plans !== null
              ? () => {
                  focus.moveTo('edit-plans');
                  setEditing(false);
                }
              : undefined
          }
          onUseBenefits={
            fromBenefits ? () => applyPlans(fromBenefits.plans, 'benefits') : undefined
          }
        />
      </>
    );
  } else {
    let intro: string;
    if (source === 'benefits' && fromBenefits) {
      intro = `${plural(fromBenefits.plans.length, 'plan')} from your benefits summary.`;
      if (fromBenefits.deadline)
        intro += ` Enrollment closes ${formatDate(fromBenefits.deadline)}.`;
      if (fromBenefits.left > 0) {
        intro += ` It lists ${plural(fromBenefits.plans.length + fromBenefits.left, 'plan')}; the first ${fromBenefits.plans.length} are compared.`;
      }
    } else {
      intro = source === 'saved' ? 'The plans in your saved decision.' : 'The plans you entered.';
    }
    body = (
      <>
        <p className="m-0 text-small text-ink-3">{intro}</p>
        <div ref={focus.target('usage')}>
          <div className="mb-1.5 text-small font-semibold text-ink-2">
            How much care do you expect next year?
          </div>
          <Seg
            label="Expected healthcare use"
            options={USAGES.map((u) => ({ value: u, label: usageLabel(u, scenarios[u]) }))}
            value={usageValue}
            onChange={(value) => edit(() => setUsage(value))}
          />
        </div>
        <AmountField
          id={`${id}-hsa`}
          label="Your own HSA contribution this year"
          value={hsaValue}
          error={hsaRead.error}
          hint="Only a plan that qualifies for an HSA can take it; the calculator keeps it within the year's limit."
          onChange={(text) => edit(() => setHsa(text))}
        />

        <PlanResult
          inputs={inputs}
          plans={plans}
          calc={calc}
          usage={usageValue}
          scenarios={scenarios}
          selected={selectedValue}
          taxYear={payStub.tax_year}
        />

        {plans !== null && (
          <div>
            <div className="mb-1.5 text-small font-semibold text-ink-2">
              Which plan will you enroll in?
            </div>
            <Seg
              label="The plan you will enroll in"
              options={plans.map((plan, index) => ({ value: String(index), label: plan.name }))}
              value={selectedValue === null ? null : String(selectedValue)}
              onChange={(value) => edit(() => setSelected(Number(value)))}
            />
          </div>
        )}
        <div>
          <Label htmlFor={`${id}-deadline`}>Enrollment deadline</Label>
          <Input
            id={`${id}-deadline`}
            type="date"
            value={deadlineValue}
            aria-describedby={`${id}-deadline-hint`}
            onChange={(e) => {
              const value = e.currentTarget.value;
              edit(() => setDeadline(value));
            }}
            className="w-48"
          />
          <p id={`${id}-deadline-hint`} className="mt-1.5 mb-0 text-tiny text-ink-3">
            Saving puts it on your calendar.
          </p>
        </div>

        {save.isError && (
          <Notice tone="warning" compact role="alert">
            {saveErrorText(save.error)}
          </Notice>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <SaveButton
              state={state}
              canSave={calc.isCurrent && selectedValue !== null}
              saving={save.isPending}
              onSave={() => {
                if (state.status === 'saved' || !calc.isCurrent || !calc.data || !calc.inputs) {
                  return;
                }
                save.mutate({ inputs: calc.inputs, result: calc.data, current });
              }}
            />
            {selectedValue === null && (
              <span className="text-small text-ink-3">
                Choose the plan you will enroll in to save.
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              ref={focus.target('edit-plans')}
              size="sm"
              onClick={() => {
                focus.moveTo('plans-form');
                setEditing(true);
              }}
            >
              Edit plans
            </Button>
            {current && (
              <Link href={whyRoute(current.id)} className="text-small">
                Why this decision
              </Link>
            )}
          </div>
        </div>
        {event && <p className="m-0 text-small text-ink-3">{calendarNote(event)}</p>}
      </>
    );
  }

  const { icon, tone } = CALCULATOR_CARDS.health_plan;
  return (
    <DecisionCard
      id="health-plan"
      title="Health plan"
      icon={icon}
      tone={tone}
      busy={!loaded && !failed}
      badge={loaded ? <Badge tone={saveBadgeTone(state.status)}>{state.label}</Badge> : undefined}
    >
      {body}
    </DecisionCard>
  );
}

interface PlanResultProps {
  inputs: HealthPlansInput | null;
  plans: readonly HealthPlanOption[] | null;
  calc: CalcState<typeof CALC_PATH>;
  usage: HealthcareUsage;
  scenarios: Scenarios;
  selected: number | null;
  taxYear: number;
}

/** The result panel: every cost, saving and break-even is a field of the calculator's result. */
function PlanResult({ inputs, plans, calc, usage, scenarios, selected, taxYear }: PlanResultProps) {
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
        {apiErrorMessage(calc.error, 'The calculator could not run. Try again in a moment.')}
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
        <span className="sr-only">Calculating.</span>
      </div>
    );
  }
  return (
    <Tile
      tone="coral"
      role="group"
      aria-label="Calculator result"
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
