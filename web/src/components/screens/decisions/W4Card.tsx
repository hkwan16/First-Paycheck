'use client';

import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { KV, KVList } from '@/components/ui/KV';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Seg } from '@/components/ui/Seg';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tile } from '@/components/ui/Tile';
import { apiErrorMessage } from '@/lib/api/errors';
import {
  useCalc,
  useCalendar,
  useDecisions,
  usePayStubs,
  useProfile,
  useSaveDecision,
  type CalcState,
} from '@/lib/api/hooks';
import type { FilingStatus, PayStub, W4Input } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { useFocusHandoff } from '@/lib/focus-handoff';
import { formatDate } from '@/lib/dates';
import {
  ageAtYearEnd,
  asW4Inputs,
  currentDecision,
  decisionSaveState,
  payPeriodsFor,
  percentInput,
} from '@/lib/decisions';
import { toneText } from '@/lib/design/tone';
import { formatMoney, formatRate } from '@/lib/money';
import { decisionStepRoute, whyRoute } from '@/lib/routes';
import { AmountField } from './AmountField';
import { CALCULATOR_CARDS, DecisionCard, SaveButton } from './DecisionCard';
import {
  amountText,
  calendarNote,
  readAmount,
  saveBadgeTone,
  saveErrorText,
} from './decision-format';
import { payFrequencyOf } from './plan-details';
import {
  appliedEntries,
  currentWithholdingOf,
  fromDecisions,
  refundHeadline,
  refundText,
  refundTone,
  scheduleText,
  suggestionText,
  W4_CONTEXT_INPUTS,
  type FromDecisions,
} from './w4-format';

const CALC_PATH = '/calc/w4';

/** The Form W-4 amounts typed on the card, each sent as integer cents. */
type AmountKey =
  | 'other_jobs_wages_cents'
  | 'other_jobs_withholding_cents'
  | 'dependents_credit_cents'
  | 'other_income_cents'
  | 'deductions_cents'
  | 'extra_withholding_cents';

/** The amounts, plus the expected deductions (empty means "the Step 4(b) entry"). */
type TextKey = AmountKey | 'expected_deductions_cents';

const FIELDS: Record<AmountKey, { label: string; example: string; hint?: string }> = {
  other_jobs_wages_cents: { label: "Other jobs' wages a year", example: '20,000.00' },
  other_jobs_withholding_cents: {
    label: "Other jobs' withholding a year",
    example: '390.00',
  },
  dependents_credit_cents: {
    label: 'Step 3: dependent credits for the year',
    example: '2,200.00',
    hint: 'The total from Step 3 of the form, for children and other dependents.',
  },
  other_income_cents: {
    label: 'Step 4(a): other income for the year',
    example: '2,000.00',
    hint: 'Interest, dividends and other income nothing withholds from.',
  },
  deductions_cents: {
    label: 'Step 4(b): deductions for the year',
    example: '5,000.00',
    hint: "From the form's Deductions Worksheet.",
  },
  extra_withholding_cents: {
    label: 'Step 4(c): extra withholding each paycheck',
    example: '50.00',
    hint: 'Withheld on top of the rest, every paycheck.',
  },
};

const AMOUNT_KEYS = Object.keys(FIELDS) as AmountKey[];

const FILING_STATUSES: readonly { value: FilingStatus; label: string }[] = [
  { value: 'single', label: 'Single or married filing separately' },
  { value: 'married_filing_jointly', label: 'Married filing jointly' },
  { value: 'head_of_household', label: 'Head of household' },
];

/**
 * The W-4 card, from docs/mockup/Decisions.dc.html. Salary and pay schedule
 * come from the profile and the confirmed pay stub, the age from the birth
 * year, and the 401(k) rate and health premium from the saved 401(k) and
 * health plan decisions (zero until they are saved). The person fills in the
 * form's steps. Every withholding, tax, refund and suggested entry is the
 * calculator's (`POST /calc/w4` through `useCalc`), and so is what the newest
 * stub's withholding leaves at tax time if nothing changes (spec 014 rule
 * 10a); "Apply suggestion" copies the suggested entries into the form.
 * Saving keeps a version and puts the reminder to hand the form in on the
 * calendar.
 */
export function W4Card() {
  const id = useId();
  const profile = useProfile();
  const payStubs = usePayStubs();
  const decisions = useDecisions();
  const calendar = useCalendar();
  const current = currentDecision(decisions.data, 'w4');
  const saved = current ? asW4Inputs(current.inputs) : null;
  const save = useSaveDecision('w4');
  const from = fromDecisions(
    currentDecision(decisions.data, 'k401_match'),
    currentDecision(decisions.data, 'health_plans'),
  );

  // What the person has set; until they touch a field, the saved decision's entry.
  const [texts, setTexts] = useState<Partial<Record<TextKey, string>>>({});
  const [status, setStatus] = useState<FilingStatus | null>(null);
  const [multipleJobs, setMultipleJobs] = useState<boolean | null>(null);
  // "Apply suggestion" leaves with its suggestion: focus the entry it filled (issue 167).
  const focus = useFocusHandoff<AmountKey>();

  const textOf = (key: TextKey) =>
    texts[key] ??
    amountText(key === 'expected_deductions_cents' ? saved?.[key] : (saved?.[key] ?? 0));
  const reads = Object.fromEntries(
    AMOUNT_KEYS.map((key) => [key, readAmount(textOf(key), { example: FIELDS[key].example })]),
  ) as Record<AmountKey, ReturnType<typeof readAmount>>;
  const expectedRead = readAmount(textOf('expected_deductions_cents'), { example: '5,000.00' });
  const statusValue = status ?? saved?.filing_status ?? profile.data?.filing_status ?? null;
  const jobsValue = multipleJobs ?? saved?.multiple_jobs ?? false;

  const loaded =
    profile.data !== undefined && payStubs.data !== undefined && decisions.data !== undefined;
  const payStub = payStubs.data?.[0];
  const frequency = loaded ? payFrequencyOf(profile.data, payStub) : null;
  const periods = payPeriodsFor(frequency);
  const salary = profile.data?.salary_cents ?? null;
  const ready = loaded && payStub !== undefined && periods !== null && salary !== null;

  let missing: string | null = null;
  if (statusValue === null) missing = 'Choose your filing status';
  else if (AMOUNT_KEYS.some((key) => reads[key].cents === null) || expectedRead.error) {
    missing = 'Enter each amount, or 0,';
  }

  const inputs: W4Input | null =
    ready && statusValue !== null && missing === null
      ? {
          salary_cents: salary,
          pay_periods_per_year: periods,
          filing_status: statusValue,
          tax_year: payStub.tax_year,
          k401_contribution_pct: from.k401Pct ?? percentInput(0),
          age: ageAtYearEnd(payStub.tax_year, profile.data?.birth_year),
          health_premium_per_paycheck_cents: from.premium?.cents ?? 0,
          multiple_jobs: jobsValue,
          ...(Object.fromEntries(AMOUNT_KEYS.map((key) => [key, reads[key].cents])) as Record<
            AmountKey,
            number
          >),
          expected_deductions_cents: expectedRead.cents,
          current_withholding_per_paycheck_cents: currentWithholdingOf(payStub, frequency),
        }
      : null;
  const calc = useCalc(CALC_PATH, inputs);
  // On the form, the badge compares what is set; elsewhere, only whether a version exists.
  // A newer stub alone does not change a saved decision (spec 014 rule 17a).
  const state = decisionSaveState(current, ready ? inputs : (current?.inputs ?? null), {
    ignore: W4_CONTEXT_INPUTS,
  });
  const edit = (apply: () => void) => {
    apply();
    if (save.isError) save.reset();
  };
  const setText = (key: TextKey, text: string) =>
    edit(() => setTexts((previous) => ({ ...previous, [key]: text })));
  const applySuggestion = () => {
    if (!calc.isCurrent || !calc.data || !calc.inputs) return;
    const entries = appliedEntries(calc.inputs, calc.data);
    focus.moveTo(
      calc.data.suggestion === 'increase_deductions'
        ? 'deductions_cents'
        : 'extra_withholding_cents',
    );
    edit(() =>
      setTexts((previous) => ({
        ...previous,
        extra_withholding_cents: amountText(entries.extra_withholding_cents),
        deductions_cents: amountText(entries.deductions_cents),
        expected_deductions_cents: amountText(entries.expected_deductions_cents),
      })),
    );
  };

  const event = calendar.data?.find(
    (e) => e.kind === 'w4_submit' && current && e.decision_id === current.id,
  );
  const amountField = (key: AmountKey) => (
    <AmountField
      inputRef={focus.target(key)}
      id={`${id}-${key}`}
      label={FIELDS[key].label}
      value={textOf(key)}
      error={reads[key].error}
      hint={FIELDS[key].hint}
      onChange={(text) => setText(key, text)}
    />
  );

  let body: ReactNode;
  const failed = profile.error ?? payStubs.error ?? decisions.error;
  if (failed) {
    body = (
      <Notice tone="warning" compact role="alert">
        {apiErrorMessage(failed, 'Could not load your details. Reload the page to try again.')}
      </Notice>
    );
  } else if (!loaded) {
    body = (
      <div className="flex flex-col gap-3">
        <Skeleton className="w-full" />
        <Skeleton className="w-3/4" />
        <span className="sr-only">Loading your W-4 details.</span>
      </div>
    );
  } else if (!payStub || periods === null) {
    body = (
      <>
        <Notice tone="blue" compact icon={null}>
          The calculator reads your pay schedule, your tax year and what you withhold now from a
          confirmed pay stub.
        </Notice>
        <div>
          <Button href="/setup/confirm" variant="primary">
            Confirm your pay stub
          </Button>
        </div>
      </>
    );
  } else if (salary === null) {
    body = (
      <Notice tone="blue" compact icon={null}>
        The calculator needs your salary. Add it with Change plan details on the 401(k) card.
      </Notice>
    );
  } else {
    const text = calc.data && inputs !== null && !calc.isError ? suggestionText(calc.data) : null;
    body = (
      <>
        <p className="m-0 text-small text-ink-3">
          Your {formatDate(payStub.pay_date, 'short')} pay stub withholds{' '}
          <Money cents={payStub.federal_withholding_cents} className="font-semibold text-ink-2" />{' '}
          of federal income tax a paycheck. Federal income tax only: state tax is not computed here.
        </p>

        <FromYourDecisions id={`${id}-decided`} from={from} />

        <div>
          <div className="mb-1.5 text-small font-semibold text-ink-2">Step 1(c): filing status</div>
          <Seg
            label="Filing status"
            options={FILING_STATUSES}
            value={statusValue}
            onChange={(value) => edit(() => setStatus(value))}
          />
        </div>

        <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
          <legend className="mb-1.5 p-0 text-small font-semibold text-ink-2">
            Step 2: other jobs in your household
          </legend>
          <Checkbox
            checked={jobsValue}
            onChange={(checked) => edit(() => setMultipleJobs(checked))}
          >
            Step 2(c): two jobs in all, with this box checked on both W-4s
          </Checkbox>
          <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            {amountField('other_jobs_wages_cents')}
            {amountField('other_jobs_withholding_cents')}
          </div>
          <p className="m-0 text-tiny text-ink-3">
            A spouse&apos;s job or a second job, for the projection only. Leave them at 0.00 when
            this is the only job.
          </p>
        </fieldset>

        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          {amountField('dependents_credit_cents')}
          {amountField('other_income_cents')}
          {amountField('deductions_cents')}
          <AmountField
            id={`${id}-expected`}
            label="Deductions you expect to claim"
            value={textOf('expected_deductions_cents')}
            error={expectedRead.error}
            placeholder="Same as Step 4(b)"
            hint="For the projection. Leave it empty when it is your Step 4(b) entry."
            onChange={(value) => setText('expected_deductions_cents', value)}
          />
          {amountField('extra_withholding_cents')}
        </div>

        <W4Result inputs={inputs} missing={missing} calc={calc} payStub={payStub} />

        {text && (
          <Notice tone="blue" compact icon={null} role="group" aria-label="Suggestion">
            <p className="m-0">{text}</p>
            <Button
              size="sm"
              className="mt-2.5"
              disabled={!calc.isCurrent}
              onClick={applySuggestion}
            >
              Apply suggestion
            </Button>
          </Notice>
        )}

        {save.isError && (
          <Notice tone="warning" compact role="alert">
            {saveErrorText(save.error)}
          </Notice>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SaveButton
            state={state}
            canSave={calc.isCurrent}
            saving={save.isPending}
            onSave={() => {
              if (state.status === 'saved' || !calc.isCurrent || !calc.data || !calc.inputs) {
                return;
              }
              save.mutate({ inputs: calc.inputs, result: calc.data, current });
            }}
          />
          {current && (
            <Link href={whyRoute(current.id)} className="text-small">
              Why this decision
            </Link>
          )}
        </div>
        {event && <p className="m-0 text-small text-ink-3">{calendarNote(event)}</p>}
      </>
    );
  }

  const { icon, tone } = CALCULATOR_CARDS.w4;
  return (
    <DecisionCard
      id="w4"
      title="W-4, federal only"
      icon={icon}
      tone={tone}
      busy={!loaded && !failed}
      badge={loaded ? <Badge tone={saveBadgeTone(state.status)}>{state.label}</Badge> : undefined}
    >
      {body}
    </DecisionCard>
  );
}

/**
 * The 401(k) rate and health premium the W-4 reads from the other saved
 * decisions, read-only, with a way to each card while one is not saved.
 */
function FromYourDecisions({ id, from }: { id: string; from: FromDecisions }) {
  const headingId = `${id}-title`;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="flex flex-col gap-1.5 rounded-control bg-well px-3.5 py-3"
    >
      <h3 id={headingId} className="m-0 text-small font-semibold text-ink-2">
        From your decisions
      </h3>
      <KVList>
        <KV
          label="401(k) contribution"
          value={from.k401Pct === null ? 'Not saved yet' : `${formatRate(from.k401Pct)} of salary`}
        />
        <KV
          label="Health premium per paycheck"
          value={
            from.premium === null
              ? 'Not saved yet'
              : `${formatMoney(from.premium.cents)}, ${from.premium.plan}`
          }
        />
      </KVList>
      {from.k401Pct === null || from.premium === null ? (
        <p className="m-0 text-tiny text-ink-3">
          The projection counts a decision that is not saved yet as zero.{' '}
          {from.k401Pct === null && (
            <Link href={decisionStepRoute('401k_match')}>Save your 401(k) decision</Link>
          )}
          {from.k401Pct === null && from.premium === null && ' · '}
          {from.premium === null && (
            <Link href={decisionStepRoute('health_plan')}>Choose your health plan</Link>
          )}
        </p>
      ) : (
        <p className="m-0 text-tiny text-ink-3">
          Both come out of your pay before income tax, so they lower what is withheld.
        </p>
      )}
    </div>
  );
}

interface W4ResultProps {
  inputs: W4Input | null;
  /** What to enter first, while the inputs are incomplete. */
  missing: string | null;
  calc: CalcState<typeof CALC_PATH>;
  /** The newest confirmed stub, which the comparison names. */
  payStub: PayStub;
}

/**
 * The result panel: every figure is a field of the calculator's result or of
 * its inputs. What the stub's withholding leaves at tax time comes first, then
 * what the entries on the form would.
 */
function W4Result({ inputs, missing, calc, payStub }: W4ResultProps) {
  const result = calc.data;
  let content: ReactNode;
  if (inputs === null) {
    content = (
      <p className="m-0 text-small text-ink-3">
        {missing ?? 'Fill in the form'} to see your numbers.
      </p>
    );
  } else if (calc.isError) {
    content = (
      <Notice tone="warning" compact role="alert">
        {apiErrorMessage(calc.error, 'The calculator could not run. Try again in a moment.')}
      </Notice>
    );
  } else if (result) {
    const tone = refundTone(result.projected_refund_cents);
    // The inputs of the result on screen (the previous one stays while the next loads).
    const shown = calc.inputs ?? inputs;
    const current = result.current_refund_cents;
    const currentWithholding = shown.current_withholding_per_paycheck_cents;
    const atStub =
      current !== null &&
      currentWithholding != null &&
      result.current_annual_withholding_cents !== null ? (
        <div role="group" aria-label="If you change nothing" className="flex flex-col gap-1">
          <div className="text-small font-semibold text-ink-2">If you change nothing</div>
          <div className={cn('text-headline font-bold', toneText[refundTone(current)])}>
            {refundHeadline(current)}
          </div>
          <p className="m-0 text-tiny text-ink-3">
            Your {formatDate(payStub.pay_date, 'short')} pay stub withholds{' '}
            <Money cents={currentWithholding} /> a paycheck:{' '}
            <Money cents={result.current_annual_withholding_cents} /> over{' '}
            {shown.pay_periods_per_year} paychecks, if every paycheck this year withholds the same.
            It changes only when you give your employer a new Form W-4.
          </p>
        </div>
      ) : null;
    content = (
      <>
        {atStub}
        <div className={cn('flex flex-col gap-1', atStub && 'border-t border-line pt-3')}>
          <div className="text-small font-semibold text-ink-2">With the entries above</div>
          <div className={cn('text-headline font-bold', toneText[tone])} aria-live="polite">
            {refundHeadline(result.projected_refund_cents)}
          </div>
          {!atStub && (
            <p className="m-0 text-tiny text-ink-3">
              Your pay stub is on a different pay schedule from your plan details, so the card
              cannot say what it withholds over the year.
            </p>
          )}
        </div>
        <KVList rules="all" spacing="panel">
          <KV
            label="Withheld each paycheck"
            value={
              <Money cents={result.withholding_per_paycheck_cents} className="font-semibold" />
            }
          />
          <KV
            label={`Withheld this year, ${shown.pay_periods_per_year} paychecks`}
            value={<Money cents={result.annual_withholding_cents} />}
          />
          {shown.dependents_credit_cents !== 0 && (
            <KV label="Tax before credits" value={<Money cents={result.projected_tax_cents} />} />
          )}
          <KV
            label={`Projected ${shown.tax_year} federal income tax`}
            value={<Money cents={result.projected_tax_after_credits_cents} />}
          />
          <KV
            label="Refund or balance due"
            value={
              <span className={cn('font-semibold', toneText[tone])}>
                {refundText(result.projected_refund_cents)}
              </span>
            }
          />
          <KV
            label="Taxable wages each paycheck"
            value={<Money cents={result.taxable_wages_per_paycheck_cents} />}
          />
        </KVList>
        <p className="m-0 text-tiny text-ink-3">
          Publication 15-T percentage method: {scheduleText(result)}. The projection uses the{' '}
          {shown.tax_year} brackets and standard deduction.
        </p>
        {result.k401_capped && (
          <Notice tone="warning" compact>
            Your 401(k) rate asks for more than this year&apos;s deferral limit, so{' '}
            <Money cents={result.k401_annual_cents} /> is counted.
          </Notice>
        )}
      </>
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
      tone="blue"
      role="group"
      aria-label="Calculator result"
      aria-busy={(inputs !== null && calc.isBusy) || undefined}
    >
      {content}
    </Tile>
  );
}
