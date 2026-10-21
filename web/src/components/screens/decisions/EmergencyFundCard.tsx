'use client';

import { useId, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { KV, KVList } from '@/components/ui/KV';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Range } from '@/components/ui/Range';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tile } from '@/components/ui/Tile';
import { apiErrorMessage } from '@/lib/api/errors';
import {
  useAccounts,
  useCalc,
  useDecisions,
  useGoals,
  usePayStubs,
  useProfile,
  useSaveDecision,
  useSpendingSummary,
  type CalcState,
} from '@/lib/api/hooks';
import type { EmergencyFundInput, SpendingSummary } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import {
  asEmergencyFundInputs,
  currentDecision,
  decisionSaveState,
  payPeriodsFor,
} from '@/lib/decisions';
import { toneText } from '@/lib/design/tone';
import { formatRate } from '@/lib/money';
import { AmountField } from './AmountField';
import { CALCULATOR_CARDS, DecisionCard, SaveButton } from './DecisionCard';
import { amountText, readAmount, saveBadgeTone, saveErrorText } from './decision-format';
import {
  accountName,
  emergencyAccount,
  essentialsPrefill,
  fundBarTone,
  fundHeadline,
  monthsText,
} from './emergency-fund-format';
import { EmergencyGoal } from './EmergencyGoal';
import { payFrequencyOf } from './plan-details';

const CALC_PATH = '/calc/emergency-fund';
/** The target slider's range: the product suggests 3 to 6 months; the calculator takes up to 12. */
const MIN_MONTHS = 3;
const MAX_MONTHS = 12;

const essentialsHint = (summary: SpendingSummary | undefined, fromSummary: boolean) =>
  fromSummary && summary
    ? `From your spending, ${formatDate(summary.start, 'short')} to ${formatDate(summary.end)}. Change it if a usual month runs higher.`
    : 'Rent, utilities, groceries, insurance and getting to work, in a usual month.';

/**
 * The emergency fund card, from docs/mockup/Decisions.dc.html. Monthly
 * essentials start from the spending summary and the savings from the account
 * marked as the emergency fund (or from the saved decision), and the person
 * sets the target and the monthly transfer. Every number in the result is
 * the calculator's (`POST /calc/emergency-fund` through `useCalc`); saving
 * makes or updates the goal (`GET /goals`), shown below with its actions.
 */
export function EmergencyFundCard() {
  const id = useId();
  const profile = useProfile();
  const payStubs = usePayStubs();
  const decisions = useDecisions();
  const accounts = useAccounts();
  const summary = useSpendingSummary();
  const goals = useGoals();
  const current = currentDecision(decisions.data, 'emergency_fund');
  const saved = current ? asEmergencyFundInputs(current.inputs) : null;
  const save = useSaveDecision('emergency_fund');

  // What the person has set; until they touch a field, the saved decision's
  // value, else what the summary and the emergency fund account say.
  const [essentials, setEssentials] = useState<string | null>(null);
  const [months, setMonths] = useState<number | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [contribution, setContribution] = useState<string | null>(null);

  const account = emergencyAccount(accounts.data);
  const prefill = essentialsPrefill(summary.data);
  const essentialsValue =
    essentials ?? amountText(saved ? saved.monthly_essentials_cents : prefill);
  const monthsValue = months ?? saved?.target_months ?? MIN_MONTHS;
  const balanceValue =
    balance ?? amountText(saved ? saved.current_balance_cents : account?.balance_cents);
  const contributionValue = contribution ?? amountText(saved?.monthly_contribution_cents);

  const essentialsRead = readAmount(essentialsValue, { example: '1,823.25', positive: true });
  const balanceRead = readAmount(balanceValue, { example: '2,140.00' });
  const contributionRead = readAmount(contributionValue, { example: '300.00' });

  // The spending summary and accounts only fill in starting values; the card waits for them.
  const loaded =
    profile.data !== undefined &&
    payStubs.data !== undefined &&
    decisions.data !== undefined &&
    !accounts.isPending &&
    !summary.isPending;
  const periods = loaded ? payPeriodsFor(payFrequencyOf(profile.data, payStubs.data[0])) : null;

  let missing: string | null = null;
  if (essentialsRead.cents === null) missing = 'Enter your essential spending';
  else if (balanceRead.cents === null) missing = 'Enter what you have saved';
  else if (contributionRead.cents === null) missing = 'Enter a monthly transfer';

  const inputs: EmergencyFundInput | null =
    periods !== null &&
    essentialsRead.cents !== null &&
    balanceRead.cents !== null &&
    contributionRead.cents !== null
      ? {
          monthly_essentials_cents: essentialsRead.cents,
          target_months: monthsValue,
          current_balance_cents: balanceRead.cents,
          monthly_contribution_cents: contributionRead.cents,
          pay_periods_per_year: periods,
        }
      : null;
  const calc = useCalc(CALC_PATH, inputs);
  const state = decisionSaveState(current, periods !== null ? inputs : (current?.inputs ?? null));
  const edit = (apply: () => void) => {
    apply();
    if (save.isError) save.reset();
  };

  const goal = goals.data?.find((g) => g.kind === 'emergency_fund');
  const savedResult = current?.result as { funded?: unknown } | undefined;

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
        <span className="sr-only">Loading your emergency fund details.</span>
      </div>
    );
  } else if (periods === null) {
    body = (
      <>
        <Notice tone="blue" compact icon={null}>
          The calculator spreads your monthly transfer over your paychecks, so it needs your pay
          schedule from a confirmed pay stub.
        </Notice>
        <div>
          <Button href="/setup/confirm" variant="primary">
            Confirm your pay stub
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <AmountField
            id={`${id}-essentials`}
            label="Essential spending per month"
            value={essentialsValue}
            error={essentialsRead.error}
            hint={essentialsHint(summary.data, !saved && prefill !== null)}
            onChange={(text) => edit(() => setEssentials(text))}
          />
          <AmountField
            id={`${id}-balance`}
            label="Saved so far"
            value={balanceValue}
            error={balanceRead.error}
            hint={
              account
                ? `The balance of ${accountName(account)}, your emergency fund account.`
                : 'No account is marked as your emergency fund, so enter what you have set aside.'
            }
            onChange={(text) => edit(() => setBalance(text))}
          />
        </div>
        <Range
          id={`${id}-months`}
          label="Months of essentials to hold"
          valueLabel={monthsText(monthsValue)}
          min={Math.min(MIN_MONTHS, monthsValue)}
          max={MAX_MONTHS}
          value={monthsValue}
          onChange={(value) => edit(() => setMonths(value))}
        />
        <AmountField
          id={`${id}-contribution`}
          label="Monthly transfer to savings"
          value={contributionValue}
          error={contributionRead.error}
          hint="What you will move into savings each month."
          placeholder="300.00"
          onChange={(text) => edit(() => setContribution(text))}
        />

        <FundResult
          inputs={inputs}
          missing={missing}
          calc={calc}
          periods={periods}
          monthsValue={monthsValue}
        />

        {save.isError && (
          <Notice tone="warning" compact role="alert">
            {saveErrorText(save.error)}
          </Notice>
        )}
        <div>
          <SaveButton
            state={state}
            canSave={calc.isCurrent}
            saving={save.isPending}
            onSave={() => {
              if (state.status === 'saved' || !calc.isCurrent || !calc.data || !calc.inputs) return;
              save.mutate({ inputs: calc.inputs, result: calc.data, current });
            }}
          />
        </div>

        {current && goal && (
          <EmergencyGoal
            goal={goal}
            accounts={accounts.data ?? []}
            funded={savedResult?.funded === true}
          />
        )}
      </>
    );
  }

  const { icon, tone } = CALCULATOR_CARDS.emergency_fund;
  return (
    <DecisionCard
      id="emergency-fund"
      title="Emergency fund"
      icon={icon}
      tone={tone}
      busy={!loaded && !failed}
      badge={loaded ? <Badge tone={saveBadgeTone(state.status)}>{state.label}</Badge> : undefined}
    >
      {body}
    </DecisionCard>
  );
}

interface FundResultProps {
  inputs: EmergencyFundInput | null;
  /** What to enter first, while the inputs are incomplete. */
  missing: string | null;
  calc: CalcState<typeof CALC_PATH>;
  periods: number;
  monthsValue: number;
}

/** The result panel: every figure is a field of the calculator's result. */
function FundResult({ inputs, missing, calc, periods, monthsValue }: FundResultProps) {
  const result = calc.data;
  let content: ReactNode;
  if (inputs === null) {
    content = (
      <p className="m-0 text-small text-ink-3">
        {missing ?? 'Fill in the amounts'} to see your numbers.
      </p>
    );
  } else if (calc.isError) {
    content = (
      <Notice tone="warning" compact role="alert">
        {apiErrorMessage(calc.error, 'The calculator could not run. Try again in a moment.')}
      </Notice>
    );
  } else if (result) {
    const reach = result.funded
      ? 'Already there'
      : result.months_to_target === null
        ? `Not within ${monthsText(result.horizon_months, { years: true })}`
        : monthsText(result.months_to_target);
    content = (
      <>
        <div className={cn('text-headline font-bold', toneText.teal)} aria-live="polite">
          {fundHeadline(result)}
        </div>
        <Bar
          tone={fundBarTone(result)}
          value={Number(result.funded_pct)}
          label="Emergency fund progress"
          valueText={`${formatRate(result.funded_pct)} of the target`}
        />
        <KVList rules="all" spacing="panel">
          <KV
            label={`Target, ${monthsText(calc.inputs?.target_months ?? monthsValue)} of essentials`}
            value={<Money cents={result.target_cents} className="font-semibold" />}
          />
          <KV
            label="Suggested range, 3 to 6 months"
            value={
              <>
                <Money cents={result.three_month_target_cents} /> to{' '}
                <Money cents={result.six_month_target_cents} />
              </>
            }
          />
          <KV label="Already saved" value={`${formatRate(result.funded_pct)} of the target`} />
          <KV label="Still to save" value={<Money cents={result.shortfall_cents} />} />
          <KV label="Months to reach it" value={reach} />
          <KV
            label={`Per paycheck, ${periods} a year`}
            value={<Money cents={result.per_paycheck_contribution_cents} tone="teal" />}
          />
        </KVList>
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
      tone="teal"
      role="group"
      aria-label="Calculator result"
      aria-busy={(inputs !== null && calc.isBusy) || undefined}
    >
      {content}
    </Tile>
  );
}
