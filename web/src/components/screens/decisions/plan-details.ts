import type {
  FilingStatus,
  MatchTierIn,
  PayFrequency,
  PayStub,
  Profile,
  ProfileIn,
} from '@/lib/api/types';
import { formatMoney, parseMoney } from '@/lib/money';

/*
 * The plan details the 401(k) card needs from the profile: salary, filing
 * status, pay schedule, the employer's match formula and the birth year (the
 * calculator's age comes from it). The API validates them again on PUT
 * /profile; these checks only say what to fix before then.
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
  payFrequency: PayFrequency | null;
  tiers: TierDraft[];
  birthYear: string;
}

export type PlanDetailsField = 'salary' | 'filingStatus' | 'payFrequency' | 'tiers' | 'birthYear';

export type PlanDetailsResult =
  | {
      ok: true;
      values: Pick<ProfileIn, 'salary_cents' | 'filing_status' | 'pay_frequency'> & {
        match_tiers: MatchTierIn[];
        birth_year: number;
      };
    }
  | { ok: false; errors: Partial<Record<PlanDetailsField, string>> };

/** The most tiers the API accepts. */
export const MAX_TIERS = 5;

/** The earliest birth year `PUT /profile` accepts. */
export const MIN_BIRTH_YEAR = 1900;

/** The pay schedule: the profile's, else the confirmed pay stub's. */
export const payFrequencyOf = (profile: Profile, payStub: PayStub | undefined) =>
  profile.pay_frequency ?? payStub?.pay_frequency ?? null;

/** Whether the card must ask for plan details before it can calculate. */
export function needsPlanDetails(profile: Profile, payStub: PayStub | undefined): boolean {
  return (
    profile.salary_cents == null ||
    profile.filing_status == null ||
    (profile.match_tiers ?? []).length === 0 ||
    profile.birth_year == null ||
    payFrequencyOf(profile, payStub) === null
  );
}

/** "4.00" as a person types it: "4". */
const typedPercent = (stored: string) => String(Number(stored));

export function draftFromProfile(profile: Profile, payStub: PayStub | undefined): PlanDetailsDraft {
  const tiers = profile.match_tiers ?? [];
  return {
    salary: profile.salary_cents == null ? '' : formatMoney(profile.salary_cents).slice(1),
    filingStatus: profile.filing_status ?? null,
    payFrequency: payFrequencyOf(profile, payStub),
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

const isPercent = (text: string) => PERCENT.test(text) && Number(text) > 0 && Number(text) <= 100;

const YEAR = /^\d{4}$/;

/**
 * The draft as profile fields, or what to fix. `taxYear` (the confirmed pay
 * stub's) bounds the birth year, since the calculator takes no negative age.
 */
export function readPlanDetails(draft: PlanDetailsDraft, taxYear?: number): PlanDetailsResult {
  const errors: Partial<Record<PlanDetailsField, string>> = {};
  const salary = parseMoney(draft.salary);
  if (salary === null || salary <= 0) errors.salary = 'Enter your yearly salary, like 65,000.00.';
  if (!draft.filingStatus) errors.filingStatus = 'Choose your filing status.';
  if (!draft.payFrequency) errors.payFrequency = 'Choose how often you are paid.';

  const tiers = draft.tiers.map((tier) => ({
    employerPct: tier.employerPct.trim(),
    uptoPct: tier.uptoPct.trim(),
  }));
  if (!tiers.every((tier) => isPercent(tier.employerPct) && isPercent(tier.uptoPct))) {
    errors.tiers = 'Enter each percentage as a number above 0 and up to 100, like 4 or 4.5.';
  } else if (
    tiers.some((tier, i) => i > 0 && Number(tier.uptoPct) <= Number(tiers[i - 1]!.uptoPct))
  ) {
    errors.tiers = 'Each tier must reach a higher percentage of pay than the one before.';
  }

  const birthText = draft.birthYear.trim();
  const birthYear = Number(birthText);
  if (!YEAR.test(birthText) || birthYear < MIN_BIRTH_YEAR) {
    errors.birthYear = 'Enter the year you were born, like 1996.';
  } else if (taxYear !== undefined && birthYear > taxYear) {
    errors.birthYear = `Enter a year no later than ${taxYear}.`;
  }

  if (Object.keys(errors).length > 0 || salary === null) return { ok: false, errors };
  return {
    ok: true,
    values: {
      salary_cents: salary,
      filing_status: draft.filingStatus,
      pay_frequency: draft.payFrequency,
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
    start_date: profile.start_date ?? null,
    vesting_years: profile.vesting_years ?? null,
  };
}
