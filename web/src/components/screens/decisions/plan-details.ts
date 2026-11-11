import type {
  FilingStatus,
  MatchTierIn,
  PayFrequency,
  PaySchedule,
  PayStub,
  Profile,
  ProfileIn,
} from '@/lib/api/types';
import { latestBirthYear, MAX_YEARLY_CENTS, MIN_BIRTH_YEAR } from '@/lib/entry-limits';
import { formatMoney } from '@/lib/money';
import { readAmount } from './decision-format';

/*
 * The plan details the 401(k) card needs from the profile: salary, filing
 * status, pay schedule, the employer's match formula and the birth year (the
 * calculator's age comes from it). The API validates them again on PUT
 * /profile; these checks only say what to fix before then. The pay schedule
 * is the one the API resolved (spec 005 rule 25a): a newest stub that states
 * one decides it, and only otherwise is it asked and saved as the profile's.
 */

export interface TierDraft {
  /** Share of each contributed dollar the employer adds, in percent. */
  employerPct: string;
  /** The tier's cumulative bound, in percent of pay. */
  uptoPct: string;
}

export interface PlanDetailsDraft {
  salary: string;
  filingStatus: FilingStatus | null;
  /** The profile's own entry, asked for only when no pay stub states the schedule. */
  payFrequency: PayFrequency | null;
  tiers: TierDraft[];
  birthYear: string;
}

export type PlanDetailsField = 'salary' | 'filingStatus' | 'payFrequency' | 'tiers' | 'birthYear';

export type PlanDetailsResult =
  | {
      ok: true;
      values: Pick<ProfileIn, 'salary_cents' | 'filing_status'> &
        Partial<Pick<ProfileIn, 'pay_frequency'>> & {
          match_tiers: MatchTierIn[];
          birth_year: number;
        };
    }
  | { ok: false; errors: Partial<Record<PlanDetailsField, string>> };

/** The most tiers the API accepts. */
export const MAX_TIERS = 5;

/**
 * The examples the salary and birth year fields show, in their placeholders
 * and in what to fix, when nothing fills them: a stub the API reports no
 * yearly salary for (no pay schedule), and a birth year nothing knows until
 * the person says it.
 */
export const SALARY_EXAMPLE = '65,000.00';
export const BIRTH_YEAR_EXAMPLE = '1996';

/** Each pay schedule in words, as a person would say it. */
export const FREQUENCY_WORDS: Record<PayFrequency, string> = {
  weekly: 'Every week',
  biweekly: 'Every two weeks',
  semimonthly: 'Twice a month',
  monthly: 'Once a month',
};

export const FREQUENCIES: readonly PayFrequency[] = [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
];

/** "Twice a month, 24 paychecks a year": the schedule the API resolved, with its count. */
export const scheduleText = (schedule: PaySchedule) =>
  `${FREQUENCY_WORDS[schedule.frequency]}, ${schedule.periods_per_year} paychecks a year`;

/** What to fix when no schedule is chosen. */
export const SCHEDULE_ERROR = 'Choose how often you are paid.';

/**
 * The pay schedule the newest pay stub states, which decides it (spec 005
 * rule 25a, issue 198), or null when the form asks for it. The form never
 * copies a stub's schedule into the profile; that copy is what went stale.
 */
export const stubSchedule = (profile: Profile): PaySchedule | null =>
  profile.pay_schedule?.source === 'pay_stub' ? profile.pay_schedule : null;

/** Whether the card must ask for plan details before it can calculate. */
export function needsPlanDetails(profile: Profile): boolean {
  return (
    profile.salary_cents == null ||
    profile.filing_status == null ||
    (profile.match_tiers ?? []).length === 0 ||
    profile.birth_year == null ||
    profile.pay_schedule === null
  );
}

/** "4.00" as a person types it: "4". */
const typedPercent = (stored: string) => String(Number(stored));

/**
 * Whether the salary starts from the confirmed stub: the profile has none and
 * the API reports the yearly salary the stub implies (`annual_salary_cents`,
 * spec 005 rule 24a; gross times pay periods, worked out by the API).
 */
export const salaryFromStub = (profile: Profile, payStub: PayStub | undefined) =>
  profile.salary_cents == null && payStub?.annual_salary_cents != null;

export function draftFromProfile(profile: Profile, payStub: PayStub | undefined): PlanDetailsDraft {
  const tiers = profile.match_tiers ?? [];
  const salary = profile.salary_cents ?? payStub?.annual_salary_cents ?? null;
  return {
    salary: salary == null ? '' : formatMoney(salary).slice(1),
    filingStatus: profile.filing_status ?? null,
    payFrequency: profile.pay_frequency ?? null,
    tiers:
      tiers.length === 0
        ? [{ employerPct: '', uptoPct: '' }]
        : tiers.map((tier) => ({
            employerPct: typedPercent(tier.employer_pct),
            uptoPct: typedPercent(tier.employee_pct_upto),
          })),
    birthYear: profile.birth_year == null ? '' : String(profile.birth_year),
  };
}

const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;
/** A percentage typed with more than two digits after the point: "4.555". */
const PERCENT_TOO_PRECISE = /^\d{1,3}\.\d{3,}$/;

const isPercent = (text: string) => PERCENT.test(text) && Number(text) > 0 && Number(text) <= 100;

const YEAR = /^\d{4}$/;

export interface ReadOptions {
  /**
   * The year it is (UTC, as the API counts it), which ends the birth years
   * `PUT /profile` takes (`latestBirthYear`, spec 006 open question 2).
   */
  currentYear: number;
  /** The form asks for the pay schedule (no `stubSchedule`); otherwise it is left out. */
  askSchedule?: boolean;
}

/** The draft as profile fields, or what to fix, naming the actual problem (spec 018 rule 5e). */
export function readPlanDetails(
  draft: PlanDetailsDraft,
  { currentYear, askSchedule: asked = false }: ReadOptions,
): PlanDetailsResult {
  const errors: Partial<Record<PlanDetailsField, string>> = {};
  const salaryRead = readAmount(draft.salary, {
    example: SALARY_EXAMPLE,
    max: MAX_YEARLY_CENTS,
    positive: true,
  });
  const salary = salaryRead.cents;
  if (salary === null) {
    errors.salary = salaryRead.error ?? `Enter your yearly salary, like ${SALARY_EXAMPLE}.`;
  }
  if (!draft.filingStatus) errors.filingStatus = 'Choose your filing status.';
  if (asked && !draft.payFrequency) errors.payFrequency = SCHEDULE_ERROR;

  const tiers = draft.tiers.map((tier) => ({
    employerPct: tier.employerPct.trim(),
    uptoPct: tier.uptoPct.trim(),
  }));
  const percentages = tiers.flatMap((tier) => [tier.employerPct, tier.uptoPct]);
  if (percentages.some((pct) => PERCENT_TOO_PRECISE.test(pct))) {
    errors.tiers =
      'Enter each percentage with at most two digits after the decimal point, like 4.5.';
  } else if (!percentages.every(isPercent)) {
    errors.tiers = 'Enter each percentage as a number above 0 and up to 100, like 4 or 4.5.';
  } else if (
    tiers.some((tier, i) => i > 0 && Number(tier.uptoPct) <= Number(tiers[i - 1]!.uptoPct))
  ) {
    errors.tiers = 'Each tier must reach a higher percentage of pay than the one before.';
  }

  const birthText = draft.birthYear.trim();
  const birthYear = Number(birthText);
  const latest = latestBirthYear(currentYear);
  if (!YEAR.test(birthText)) {
    errors.birthYear = `Enter the year you were born, like ${BIRTH_YEAR_EXAMPLE}.`;
  } else if (birthYear < MIN_BIRTH_YEAR || birthYear > latest) {
    errors.birthYear = `Enter a year from ${MIN_BIRTH_YEAR} to ${latest}.`;
  }

  if (Object.keys(errors).length > 0 || salary === null) return { ok: false, errors };
  return {
    ok: true,
    values: {
      salary_cents: salary,
      filing_status: draft.filingStatus,
      ...(asked ? { pay_frequency: draft.payFrequency } : {}),
      match_tiers: tiers.map((tier) => ({
        employer_pct: tier.employerPct,
        employee_pct_upto: tier.uptoPct,
      })),
      birth_year: birthYear,
    },
  };
}

/** The saved profile as `PUT /profile` takes it: every field, since one left out is reset. */
export function profileInput(profile: Profile): ProfileIn {
  return {
    birth_year: profile.birth_year ?? null,
    dependents: profile.dependents ?? 0,
    expected_healthcare_usage: profile.expected_healthcare_usage ?? null,
    filing_status: profile.filing_status ?? null,
    match_tiers: profile.match_tiers ?? [],
    other_jobs: profile.other_jobs ?? [],
    pay_frequency: profile.pay_frequency ?? null,
    salary_cents: profile.salary_cents ?? null,
    salary_pay_stub_id: profile.salary_pay_stub_id ?? null,
    start_date: profile.start_date ?? null,
    vesting_years: profile.vesting_years ?? null,
  };
}

/**
 * The stub a salary saved with the plan details was compared with (spec 005
 * rule 24c): the newest stub once the person saves a salary other than the
 * saved one, since they typed it (or took the stub's) with that stub on hand;
 * otherwise the stub compared before, so saving another field never answers
 * an open salary question for them.
 */
export function salaryStubId(
  profile: Profile,
  payStub: PayStub | undefined,
  salaryCents: ProfileIn['salary_cents'],
): string | null {
  if (payStub && (salaryCents ?? null) !== (profile.salary_cents ?? null)) return payStub.id;
  return profile.salary_pay_stub_id ?? null;
}
