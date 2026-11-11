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
import { apiErrorMessage } from '@/lib/api/errors';
import {
  useCalc,
  useCalendar,
  useDecisions,
  usePayStubs,
  useProfile,
  useSaveDecision,
} from '@/lib/api/hooks';
import type { FilingStatus, W4Input } from '@/lib/api/types';
import { useFocusHandoff } from '@/lib/focus-handoff';
import { formatDate } from '@/lib/dates';
import {
  ageAtYearEnd,
  asW4Inputs,
  currentDecision,
  decisionSaveState,
  percentInput,
} from '@/lib/decisions';
import { formatMoney, formatRate } from '@/lib/money';
import { decisionStepRoute, whyRoute } from '@/lib/routes';
import { MAX_PERIOD_CENTS, MAX_STEP3_CREDITS_CENTS, MAX_YEARLY_CENTS } from '@/lib/entry-limits';
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
  appliedEntries,
  fromDecisions,
  hasMoreEntries,
  suggestionText,
  W4_CONTEXT_INPUTS,
  type FromDecisions,
} from './w4-format';
import { ReviewNotice } from './ReviewNotice';
import { SalaryQuestion } from './SalaryQuestion';
import { W4_CALC_PATH, W4Result } from './W4Result';

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

/** Each amount's label, example and the most the API takes for it (spec 014 rule 16a). */
const FIELDS: Record<AmountKey, { label: string; example: string; max: number; hint?: string }> = {
  other_jobs_wages_cents: {
    label: "Other jobs' wages a year",
    example: '20,000.00',
    max: MAX_YEARLY_CENTS,
  },
  other_jobs_withholding_cents: {
    label: "Other jobs' withholding a year",
    example: '390.00',
    max: MAX_YEARLY_CENTS,
  },
  dependents_credit_cents: {
    label: 'Step 3: credits for dependents, for the year',
    example: '2,200.00',
    max: MAX_STEP3_CREDITS_CENTS,
    hint: 'The total from Step 3 of the form, for children and other dependents.',
  },
  other_income_cents: {
    label: 'Step 4(a): other income for the year',
    example: '2,000.00',
    max: MAX_YEARLY_CENTS,
    hint: 'Interest, dividends and other income with no tax taken out.',
  },
  deductions_cents: {
    label: 'Step 4(b): deductions for the year',
    example: '5,000.00',
    max: MAX_YEARLY_CENTS,
    hint: 'From the Deductions Worksheet that comes with the form.',
  },
  extra_withholding_cents: {
    label: 'Step 4(c): extra withholding each paycheck',
    example: '50.00',
    max: MAX_PERIOD_CENTS,
    hint: 'Extra tax taken out of every paycheck, on top of the rest.',
  },
};

const AMOUNT_KEYS: readonly AmountKey[] = [
  'other_jobs_wages_cents',
  'other_jobs_withholding_cents',
  'dependents_credit_cents',
  'other_income_cents',
  'deductions_cents',
  'extra_withholding_cents',
];

const MORE_ANSWERS = [
  { value: 'no', label: 'No' },
  { value: 'yes', label: 'Yes' },
] as const;

const FILING_STATUSES: readonly { value: FilingStatus; label: string }[] = [
  { value: 'single', label: 'Single or married filing separately' },
  { value: 'married_filing_jointly', label: 'Married filing jointly' },
  { value: 'head_of_household', label: 'Head of household' },
];

/**
 * The W-4 card, from docs/mockup/Decisions.dc.html. Salary and pay schedule
 * come from the profile (the schedule is the API's, the newest stub's first:
 * spec 005 rule 25a), the age from the birth year, and the 401(k) rate and
 * health premium from the saved 401(k) and health plan decisions (zero until
 * they are saved). The person picks a filing status; every other entry on the
 * form waits behind one question (spec 014 rule 20). Every withholding, tax,
 * refund and suggested entry is the calculator's (`POST /calc/w4` through
 * `useCalc`), and so is what the newest stub's withholding leaves at tax time
 * if nothing changes (spec 014 rule 10a); "Apply suggestion" copies the
 * suggested entries into the form. Saving keeps a version and puts the
 * reminder to hand the form in on the calendar.
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
  // "Anything else on your W-4?" answered Yes; the entries also show while any holds a value.
  const [askedForMore, setAskedForMore] = useState(false);
  // "Apply suggestion" leaves with its suggestion: focus the entry it filled (issue 167).
  // Or, once the salary question is answered, the filing status: the first control.
  const focus = useFocusHandoff<AmountKey | 'filing'>();

  const textOf = (key: TextKey) =>
    texts[key] ??
    amountText(key === 'expected_deductions_cents' ? saved?.[key] : (saved?.[key] ?? 0));
  const reads = Object.fromEntries(
    AMOUNT_KEYS.map((key) => [
      key,
      readAmount(textOf(key), { example: FIELDS[key].example, max: FIELDS[key].max }),
    ]),
  ) as Record<AmountKey, ReturnType<typeof readAmount>>;
  const expectedRead = readAmount(textOf('expected_deductions_cents'), {
    example: '5,000.00',
    max: MAX_YEARLY_CENTS,
  });
  const statusValue = status ?? saved?.filing_status ?? profile.data?.filing_status ?? null;
  const jobsValue = multipleJobs ?? saved?.multiple_jobs ?? false;
  const showMore =
    askedForMore ||
    hasMoreEntries({
      multipleJobs: jobsValue,
      amounts: AMOUNT_KEYS.map((key) => reads[key]),
      expected: expectedRead,
    });

  const loaded =
    profile.data !== undefined && payStubs.data !== undefined && decisions.data !== undefined;
  const payStub = payStubs.data?.[0];
  const periods = profile.data?.pay_schedule?.periods_per_year ?? null;
  const salary = profile.data?.salary_cents ?? null;
  // The salary question is open (spec 005 rule 24c): nothing is worked out until it is answered.
  const question = profile.data?.salary_review ?? null;
  const ready =
    loaded && payStub !== undefined && periods !== null && salary !== null && question === null;

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
          // The newest stub is on the user's schedule, which is its own when it prints one.
          current_withholding_per_paycheck_cents: payStub.federal_withholding_cents,
        }
      : null;
  const calc = useCalc(W4_CALC_PATH, inputs);
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
  // No means none (spec 014 rule 20): the box clear, every amount 0 and no expected deductions.
  const answerMore = (answer: 'no' | 'yes') =>
    edit(() => {
      setAskedForMore(answer === 'yes');
      if (answer === 'yes') return;
      setMultipleJobs(false);
      setTexts((previous) => ({
        ...previous,
        ...Object.fromEntries(AMOUNT_KEYS.map((key) => [key, amountText(0)])),
        expected_deductions_cents: amountText(null),
      }));
    });
  const applySuggestion = () => {
    if (!calc.isCurrent || !calc.data || !calc.inputs) return;
    const entries = appliedEntries(calc.inputs, calc.data);
    focus.moveTo(
      calc.data.suggestion === 'increase_deductions'
        ? 'deductions_cents'
        : 'extra_withholding_cents',
    );
    edit(() => {
      setAskedForMore(true);
      setTexts((previous) => ({
        ...previous,
        extra_withholding_cents: amountText(entries.extra_withholding_cents),
        deductions_cents: amountText(entries.deductions_cents),
        expected_deductions_cents: amountText(entries.expected_deductions_cents),
      }));
    });
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
  } else if (!payStub) {
    body = (
      <>
        <Notice tone="blue" compact icon={null}>
          This step reads your tax year and the federal tax taken out of your pay from a confirmed
          pay stub.
        </Notice>
        <div>
          <Button href="/setup/confirm" variant="primary">
            Confirm your pay stub
          </Button>
        </div>
      </>
    );
  } else if (salary === null || periods === null) {
    body = (
      <Notice tone="blue" compact icon={null}>
        This step needs your yearly salary and how often you are paid.{' '}
        <Link href={decisionStepRoute('401k_match')}>Add them on the 401(k) step</Link>.
      </Notice>
    );
  } else if (question !== null) {
    body = (
      <SalaryQuestion
        profile={profile.data!}
        question={question}
        onAnswered={() => focus.moveTo('filing')}
      />
    );
  } else {
    const text = calc.data && inputs !== null && !calc.isError ? suggestionText(calc.data) : null;
    body = (
      <>
        <p className="m-0 text-small text-ink-3">
          Your {formatDate(payStub.pay_date, 'short')} pay stub takes{' '}
          <Money cents={payStub.federal_withholding_cents} className="font-semibold text-ink-2" />{' '}
          of federal income tax out of each paycheck. State income tax is not part of this step.
        </p>

        <FromYourDecisions id={`${id}-decided`} from={from} />

        <div ref={focus.target('filing')}>
          <div className="mb-1.5 text-small font-semibold text-ink-2">Step 1(c): filing status</div>
          <Seg
            label="Filing status"
            options={FILING_STATUSES}
            value={statusValue}
            onChange={(value) => edit(() => setStatus(value))}
          />
        </div>

        <div>
          <div className="mb-1.5 text-small font-semibold text-ink-2" aria-hidden>
            Anything else on your W-4?
          </div>
          <Seg
            label="Anything else on your W-4?"
            options={MORE_ANSWERS}
            value={showMore ? 'yes' : 'no'}
            describedBy={`${id}-more-hint`}
            onChange={answerMore}
          />
          <p id={`${id}-more-hint`} className="mt-1.5 mb-0 text-tiny text-ink-3">
            Yes if you have a second job or a working spouse, claim dependents, have income with no
            tax taken out, or want extra tax taken out.
          </p>
        </div>

        {showMore && (
          <>
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
                Your spouse&apos;s job or your own second job. They change the estimate for tax
                time, and this job&apos;s paycheck stays the same. Leave them at 0.00 if there is no
                other job.
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
                hint="For the estimate at tax time. Leave it empty if it is the same as Step 4(b)."
                onChange={(value) => setText('expected_deductions_cents', value)}
              />
              {amountField('extra_withholding_cents')}
            </div>
          </>
        )}

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
      {loaded && !failed && current && <ReviewNotice decision={current} />}
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
          A decision you have not saved yet counts as zero here.{' '}
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
          Both come out of your pay before income tax, so less tax is taken out.
        </p>
      )}
    </div>
  );
}
