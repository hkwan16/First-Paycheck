import { describe, expect, it } from 'vitest';
import { sampleProfile } from '@/test/fixtures/decisions';
import { emptyProfile, samplePayStub } from '@/test/fixtures/documents';
import {
  draftFromProfile,
  needsPlanDetails,
  profileInput,
  readPlanDetails,
  salaryFromStub,
  type PlanDetailsDraft,
} from './plan-details';

const stub = samplePayStub();

const draft = (overrides: Partial<PlanDetailsDraft> = {}): PlanDetailsDraft => ({
  salary: '65,000.00',
  filingStatus: 'single',
  payFrequency: 'semimonthly',
  tiers: [{ employerPct: '100', uptoPct: '4' }],
  birthYear: '1996',
  ...overrides,
});

describe('needsPlanDetails', () => {
  it('is false once salary, filing status, pay schedule, match formula and birth year are known', () => {
    expect(needsPlanDetails(sampleProfile, stub)).toBe(false);
  });

  it.each([
    ['salary', { salary_cents: null }],
    ['filing status', { filing_status: null }],
    ['match formula', { match_tiers: [] }],
    ['birth year', { birth_year: null }],
  ])('is true without a %s', (_, overrides) => {
    expect(needsPlanDetails({ ...sampleProfile, ...overrides }, stub)).toBe(true);
  });

  it('takes the pay schedule from the pay stub when the profile has none', () => {
    const profile = { ...sampleProfile, pay_frequency: null };
    expect(needsPlanDetails(profile, stub)).toBe(false);
    expect(needsPlanDetails(profile, { ...stub, pay_frequency: null })).toBe(true);
  });
});

describe('draftFromProfile', () => {
  it('starts a new profile from the stub: its pay schedule and the yearly salary the API reports for it', () => {
    expect(draftFromProfile(emptyProfile, stub)).toEqual({
      salary: '64,999.92',
      filingStatus: null,
      payFrequency: 'semimonthly',
      tiers: [{ employerPct: '', uptoPct: '' }],
      birthYear: '',
    });
  });

  it('leaves the salary empty when the API reports none for the stub, or there is no stub', () => {
    const noFrequency = { ...stub, pay_frequency: null, annual_salary_cents: null };
    expect(draftFromProfile(emptyProfile, noFrequency).salary).toBe('');
    expect(draftFromProfile(emptyProfile, undefined).salary).toBe('');
  });

  it("keeps the profile's own salary over the stub's", () => {
    expect(draftFromProfile(sampleProfile, stub).salary).toBe('65,000.00');
  });
});

describe('salaryFromStub', () => {
  it('is true only when the salary starts from the stub', () => {
    expect(salaryFromStub(emptyProfile, stub)).toBe(true);
    expect(salaryFromStub(sampleProfile, stub)).toBe(false);
    expect(salaryFromStub(emptyProfile, { ...stub, annual_salary_cents: null })).toBe(false);
    expect(salaryFromStub(emptyProfile, undefined)).toBe(false);
  });
});

describe('draftFromProfile, saved', () => {
  it('shows what is saved, as the person would type it', () => {
    expect(draftFromProfile(sampleProfile, stub)).toEqual(
      draft({ salary: '65,000.00', tiers: [{ employerPct: '100', uptoPct: '4' }] }),
    );
  });
});

describe('readPlanDetails', () => {
  it('reads salary as cents and percentages as the strings typed', () => {
    const tiers = [
      { employerPct: '100', uptoPct: '3' },
      { employerPct: '50', uptoPct: '5.5' },
    ];
    expect(readPlanDetails(draft({ salary: '$60,000', tiers }))).toEqual({
      ok: true,
      values: {
        salary_cents: 6_000_000,
        filing_status: 'single',
        pay_frequency: 'semimonthly',
        match_tiers: [
          { employer_pct: '100', employee_pct_upto: '3' },
          { employer_pct: '50', employee_pct_upto: '5.5' },
        ],
        birth_year: 1996,
      },
    });
  });

  it('says what to fix for each missing or unreadable field', () => {
    const result = readPlanDetails({
      salary: 'sixty',
      filingStatus: null,
      payFrequency: null,
      tiers: [{ employerPct: '', uptoPct: '4' }],
      birthYear: '',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        salary: 'Enter your yearly salary, like 65,000.00.',
        filingStatus: 'Choose your filing status.',
        payFrequency: 'Choose how often you are paid.',
        tiers: 'Enter each percentage as a number above 0 and up to 100, like 4 or 4.5.',
        birthYear: 'Enter the year you were born, like 1996.',
      },
    });
  });

  it.each(['96', '1899', 'nineteen', '1996.5'])('refuses the birth year %j', (birthYear) => {
    expect(readPlanDetails(draft({ birthYear }))).toEqual({
      ok: false,
      errors: { birthYear: 'Enter the year you were born, like 1996.' },
    });
  });

  it('refuses a birth year after the pay stub tax year', () => {
    expect(readPlanDetails(draft({ birthYear: '2027' }), 2026)).toEqual({
      ok: false,
      errors: { birthYear: 'Enter a year no later than 2026.' },
    });
    expect(readPlanDetails(draft({ birthYear: '2026' }), 2026).ok).toBe(true);
  });

  it.each(['0', '101', '4.555', '-4', 'four'])('refuses the percentage %j', (pct) => {
    expect(readPlanDetails(draft({ tiers: [{ employerPct: '100', uptoPct: pct }] })).ok).toBe(
      false,
    );
  });

  it('refuses a zero salary', () => {
    expect(readPlanDetails(draft({ salary: '0' })).ok).toBe(false);
  });

  it('needs each tier to reach further than the one before', () => {
    const tiers = [
      { employerPct: '100', uptoPct: '5' },
      { employerPct: '50', uptoPct: '3' },
    ];
    expect(readPlanDetails(draft({ tiers }))).toEqual({
      ok: false,
      errors: { tiers: 'Each tier must reach a higher percentage of pay than the one before.' },
    });
  });
});

describe('profileInput', () => {
  it('keeps every saved field, since PUT /profile resets what it is not sent', () => {
    expect(profileInput({ ...sampleProfile, dependents: 2, vesting_years: 3 })).toEqual({
      birth_year: 1996,
      dependents: 2,
      expected_healthcare_usage: null,
      filing_status: 'single',
      match_tiers: sampleProfile.match_tiers,
      other_jobs: [],
      pay_frequency: 'semimonthly',
      salary_cents: 6_500_000,
      start_date: null,
      vesting_years: 3,
    });
  });
});
