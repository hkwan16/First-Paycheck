'use client';

import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { KVList } from '@/components/ui/KV';
import { Label } from '@/components/ui/Label';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Range } from '@/components/ui/Range';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tile } from '@/components/ui/Tile';
import { apiErrorCode, apiErrorMessage } from '@/lib/api/errors';
import {
  ResultMismatch,
  useCalc,
  useDecisions,
  usePayStubs,
  useProfile,
  useSaveDecision,
  type CalcState,
} from '@/lib/api/hooks';
import type { K401MatchInput, PayStub, Profile } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import {
  asK401Inputs,
  currentDecision,
  decisionSaveState,
  payPeriodsFor,
  percentInput,
  type DecisionSaveState,
} from '@/lib/decisions';
import { toneText } from '@/lib/design/tone';
import { formatRate } from '@/lib/money';
import { whyRoute } from '@/lib/routes';
import { CALCULATOR_CARDS, DecisionCard } from './DecisionCard';
import { matchHeadline, saveBadgeTone, tiersText } from './decision-format';
import { K401Notices, K401ResultRows } from './K401Result';
import { needsPlanDetails, payFrequencyOf } from './plan-details';
import { PlanDetailsForm } from './PlanDetailsForm';

const CALC_PATH = '/calc/401k-match';
const SLIDER_MAX = 15;

/** An age the calculator accepts (0 to 130), or null. */
function readAge(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const age = Number(text);
  return age <= 130 ? age : null;
}

/** Why a save failed, as a sentence. */
function saveErrorText(error: unknown): string {
  if (error instanceof ResultMismatch) {
    return "The calculator's numbers had changed since they were shown. They are up to date now: check them and save again.";
  }
  if (apiErrorCode(error) === 'decision_conflict') {
    return 'This decision was saved somewhere else since you opened it, so the latest version is loaded. Save again to replace it with these numbers.';
  }
  return apiErrorMessage(error, 'Could not save this decision. Try again.');
}

interface Ready {
  profile: Profile;
  payStub: PayStub;
}

/**
 * The calculator's inputs from the profile, the pay stub and what the person
 * set, or null until they can be sent (no age yet). Percentages go in the
 * API's stored form, so they compare equal to a saved decision's inputs.
 */
function k401Inputs(ready: Ready | null, age: string, pct: number): K401MatchInput | null {
  if (!ready) return null;
  const { profile, payStub } = ready;
  const periods = payPeriodsFor(payFrequencyOf(profile, payStub));
  const ageValue = readAge(age);
  if (ageValue === null || periods === null || !profile.filing_status) return null;
  if (profile.salary_cents == null) return null;
  return {
    salary_cents: profile.salary_cents,
    pay_periods_per_year: periods,
    match_tiers: profile.match_tiers ?? [],
    contribution_pct: percentInput(pct),
    tax_year: payStub.tax_year,
    filing_status: profile.filing_status,
    age: ageValue,
  };
}

/**
 * The 401(k) match card, from docs/mockup/Decisions.dc.html. Salary, pay
 * schedule, filing status and the match formula come from the profile (asked
 * for here when missing), the tax year from the confirmed pay stub, and the
 * person sets their contribution and age. Every number in the result is the
 * calculator's (`POST /calc/401k-match` through `useCalc`); saving sends that
 * result back for the server to recompute and keep as the next version.
 */
export function Match401kCard() {
  const profile = useProfile();
  const payStubs = usePayStubs();
  const decisions = useDecisions();
  const current = currentDecision(decisions.data, 'k401_match');
  const payStub = payStubs.data?.[0];
  const saved = current ? asK401Inputs(current.inputs) : null;

  const [editing, setEditing] = useState(false);
  // What the person has set; until they touch a control, the saved decision's values.
  const [contribution, setContribution] = useState<number | null>(null);
  const [ageText, setAgeText] = useState<string | null>(null);
  const pct = contribution ?? (saved ? Number(saved.contribution_pct) : 0);
  const age = ageText ?? (saved ? String(saved.age) : '');
  const save = useSaveDecision('k401_match');

  const loaded = profile.data !== undefined && payStubs.data !== undefined && decisions.data;
  const ready: Ready | null =
    loaded && payStub && !editing && !needsPlanDetails(profile.data, payStub)
      ? { profile: profile.data, payStub }
      : null;

  const inputs = k401Inputs(ready, age, pct);
  const calc = useCalc(CALC_PATH, inputs);

  // On the calculator, the badge compares what is set; elsewhere, only whether a version exists.
  const state = decisionSaveState(current, ready ? inputs : (current?.inputs ?? null));
  const edit = (apply: () => void) => {
    apply();
    if (save.isError) save.reset();
  };

  let body: ReactNode;
  const failed = profile.error ?? payStubs.error ?? decisions.error;
  if (failed) {
    body = (
      <Notice tone="warning" compact role="alert">
        {apiErrorMessage(failed, 'Could not load your plan details. Reload the page to try again.')}
      </Notice>
    );
  } else if (!loaded) {
    body = (
      <div className="flex flex-col gap-3">
        <Skeleton className="w-full" />
        <Skeleton className="w-3/4" />
        <span className="sr-only">Loading your 401(k) details.</span>
      </div>
    );
  } else if (!payStub) {
    body = (
      <>
        <Notice tone="blue" compact icon={null}>
          The calculator reads your tax year and pay schedule from a confirmed pay stub.
        </Notice>
        <div>
          <Button href="/setup/confirm" variant="primary">
            Confirm your pay stub
          </Button>
        </div>
      </>
    );
  } else if (!ready) {
    const complete = !needsPlanDetails(profile.data, payStub);
    body = (
      <PlanDetailsForm
        profile={profile.data}
        payStub={payStub}
        onSaved={() => setEditing(false)}
        onCancel={complete ? () => setEditing(false) : undefined}
      />
    );
  } else {
    body = (
      <Calculator
        {...ready}
        pct={pct}
        age={age}
        inputs={inputs}
        calc={calc}
        state={state}
        saving={save.isPending}
        saveError={save.isError ? saveErrorText(save.error) : null}
        whyHref={current ? whyRoute(current.id) : null}
        onContribution={(value) => edit(() => setContribution(value))}
        onAge={(value) => edit(() => setAgeText(value))}
        onSave={() => {
          if (state.status === 'saved' || !calc.isCurrent || !calc.data || !calc.inputs) return;
          save.mutate({ inputs: calc.inputs, result: calc.data, current });
        }}
        onEditPlan={() => setEditing(true)}
      />
    );
  }

  const { icon, tone } = CALCULATOR_CARDS['401k_match'];
  return (
    <DecisionCard
      id="k401"
      title="401(k) match"
      icon={icon}
      tone={tone}
      busy={!loaded && !failed}
      badge={loaded ? <Badge tone={saveBadgeTone(state.status)}>{state.label}</Badge> : undefined}
    >
      {body}
    </DecisionCard>
  );
}

interface CalculatorProps extends Ready {
  pct: number;
  age: string;
  inputs: K401MatchInput | null;
  calc: CalcState<typeof CALC_PATH>;
  state: DecisionSaveState;
  saving: boolean;
  saveError: string | null;
  whyHref: ReturnType<typeof whyRoute> | null;
  onContribution: (value: number) => void;
  onAge: (value: string) => void;
  onSave: () => void;
  onEditPlan: () => void;
}

/** The controls, the result panel and the save row. */
function Calculator({
  profile,
  payStub,
  pct,
  age,
  inputs,
  calc,
  state,
  saving,
  saveError,
  whyHref,
  onContribution,
  onAge,
  onSave,
  onEditPlan,
}: CalculatorProps) {
  const ageId = useId();
  const employer = payStub.employer_name ?? 'Your employer';
  const result = calc.data;

  return (
    <>
      <p className="m-0 text-small text-ink-3">
        {employer} matches{' '}
        <strong className="text-ink-2">{tiersText(profile.match_tiers ?? [])}</strong> of your{' '}
        <Money cents={profile.salary_cents ?? 0} decimals={0} /> salary. Your{' '}
        {formatDate(payStub.pay_date, 'short')} pay stub shows{' '}
        <Money cents={payStub.retirement_contribution_cents} /> a paycheck going to your 401(k).
      </p>

      <div>
        <Label htmlFor={ageId}>Your age at the end of {payStub.tax_year}</Label>
        <Input
          id={ageId}
          type="number"
          inputMode="numeric"
          min={0}
          max={130}
          value={age}
          aria-describedby={`${ageId}-hint`}
          onChange={(event) => onAge(event.currentTarget.value)}
          className="w-28 tabular-nums"
        />
        <p id={`${ageId}-hint`} className="mt-1.5 mb-0 text-tiny text-ink-3">
          Only used for the extra amount the IRS allows at 50 and over.
        </p>
      </div>

      <Range
        id="k401-contribution"
        label="Your contribution"
        valueLabel={`${formatRate(pct)} of salary`}
        min={0}
        max={Math.max(SLIDER_MAX, Math.ceil(pct))}
        step={1}
        value={pct}
        onChange={onContribution}
      />

      <Tile
        tone="plum"
        role="group"
        aria-label="Calculator result"
        aria-busy={(inputs !== null && calc.isBusy) || undefined}
      >
        {inputs === null ? (
          <p className="m-0 text-small text-ink-3">Enter your age to see your numbers.</p>
        ) : calc.isError ? (
          <Notice tone="warning" compact role="alert">
            {apiErrorMessage(calc.error, 'The calculator could not run. Try again in a moment.')}
          </Notice>
        ) : result ? (
          <>
            <div className={cn('text-headline font-bold', toneText.plum)} aria-live="polite">
              {matchHeadline(result)}
            </div>
            <KVList rules="all" spacing="panel">
              <K401ResultRows result={result} employer={employer} />
            </KVList>
          </>
        ) : (
          <div className="flex flex-col gap-2.5">
            <Skeleton className="w-3/4" />
            <Skeleton className="w-full" />
            <Skeleton className="w-full" />
            <span className="sr-only">Calculating.</span>
          </div>
        )}
      </Tile>

      {result && inputs !== null && !calc.isError && (
        <K401Notices result={result} taxYear={payStub.tax_year} />
      )}

      {saveError && (
        <Notice tone="warning" compact role="alert">
          {saveError}
        </Notice>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {state.status === 'saved' ? (
          <Button variant="confirmed" pressed onClick={onSave}>
            {state.action}
          </Button>
        ) : (
          <Button variant="primary" disabled={!calc.isCurrent} loading={saving} onClick={onSave}>
            {state.action}
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={onEditPlan}>
            Change plan details
          </Button>
          {whyHref && (
            <Link href={whyHref} className="text-small">
              Why this decision
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
