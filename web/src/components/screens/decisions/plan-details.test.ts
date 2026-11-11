import { describe, expect, it } from 'vitest';
import { sampleProfile } from '@/test/fixtures/decisions';
import { emptyProfile, samplePayStub } from '@/test/fixtures/documents';
import {
  draftFromProfile,
  needsPlanDetails,
  profileInput,
  readPlanDetails,
  salaryFromStub,
  salaryStubId,
  stubSchedule,
  type PlanDetailsDraft,
  type ReadOptions,
} from './plan-details';

const stub = samplePayStub();

/** Read in 2026, when the latest birth year is 2012 (spec 006 open question 2). */
const read = (details: PlanDetailsDraft, options: Partial<ReadOptions> = {}) =>
  readPlanDetails(details, { currentYear: 2026, ...options });

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
    expect(needsPlanDetails(sampleProfile)).toBe(false);
  });

  it.each([
    ['salary', { salary_cents: null }],
    ['filing status', { filing_status: null }],
    ['match formula', { match_tiers: [] }],
    ['birth year', { birth_year: null }],
    ['pay schedule', { pay_schedule: null }],
  ])('is true without a %s', (_, overrides) => {
    expect(needsPlanDetails({ ...sampleProfile, ...overrides })).toBe(true);
  });

  it("reads the pay schedule the API resolved, never the profile's own entry (spec 005 rule 25a)", () => {
    expect(needsPlanDetails({ ...sampleProfile, pay_frequency: null })).toBe(false);
  });
});

describe('draftFromProfile', () => {
  it("starts a new profile's salary from the stub, and never copies its schedule (issue 198)", () => {
    expect(draftFromProfile(emptyProfile, stub)).toEqual({
      salary: '64,999.92',
      filingStatus: null,
      payFrequency: null,
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

describe('stubSchedule', () => {
  it("is the newest stub's schedule, and null when the form asks for one", () => {
    expect(stubSchedule(sampleProfile)).toEqual(sampleProfile.pay_schedule);
    expect(stubSchedule({ ...sampleProfile, pay_schedule: null })).toBeNull();
    expect(
      stubSchedule({
        ...sampleProfile,
        pay_schedule: {
          frequency: 'biweekly',
          periods_per_year: 26,
          source: 'profile',
          pay_stub_date: null,
        },
      }),
    ).toBeNull();
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
    expect(read(draft({ salary: '$60,000', tiers }), { askSchedule: true })).toEqual({
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
    const result = read(
      {
        salary: 'sixty',
        filingStatus: null,
        payFrequency: null,
        tiers: [{ employerPct: '', uptoPct: '4' }],
        birthYear: '',
      },
      { askSchedule: true },
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        salary: 'Enter an amount, like 65,000.00.',
        filingStatus: 'Choose your filing status.',
        payFrequency: 'Choose how often you are paid.',
        tiers: 'Enter each percentage as a number above 0 and up to 100, like 4 or 4.5.',
        birthYear: 'Enter the year you were born, like 1996.',
      },
    });
  });

  it('leaves the schedule out when the stub states it, so the profile keeps its own', () => {
    const result = read(draft({ payFrequency: null }), { askSchedule: false });
    expect(result.ok && 'pay_frequency' in result.values).toBe(false);
    expect(result.ok).toBe(true);
  });

  it.each(['96', 'nineteen', '1996.5'])('refuses the birth year %j', (birthYear) => {
    expect(read(draft({ birthYear }))).toEqual({
      ok: false,
      errors: { birthYear: 'Enter the year you were born, like 1996.' },
    });
  });

  // Spec 018 rule 5e (issue 238): a birth year of 2020 was saved before.
  it.each(['2013', '2020', '2026', '1899', '1800'])(
    'refuses a birth year outside 1900 to 2012 in 2026: %j',
    (birthYear) => {
      expect(read(draft({ birthYear }))).toEqual({
        ok: false,
        errors: { birthYear: 'Enter a year from 1900 to 2012.' },
      });
    },
  );

  it('takes the years at either end of the range', () => {
    expect(read(draft({ birthYear: '2012' })).ok).toBe(true);
    expect(read(draft({ birthYear: '1900' })).ok).toBe(true);
    expect(read(draft({ birthYear: '2013' }), { currentYear: 2027 }).ok).toBe(true);
  });

  it('asks for the salary when it is empty, and names its range when it is outside it', () => {
    expect(read(draft({ salary: '' }))).toEqual({
      ok: false,
      errors: { salary: 'Enter your yearly salary, like 65,000.00.' },
    });
    for (const salary of ['0', '65,000,000', '10,000,000.01']) {
      expect(read(draft({ salary }))).toEqual({
        ok: false,
        errors: { salary: 'Enter an amount above $0 and up to $10,000,000.00.' },
      });
    }
    expect(read(draft({ salary: '65,000.123' }))).toEqual({
      ok: false,
      errors: { salary: 'Enter at most two digits after the decimal point, like 65,000.00.' },
    });
    expect(read(draft({ salary: '10,000,000.00' })).ok).toBe(true);
  });

  it('says a percentage has too many digits after the point', () => {
    expect(read(draft({ tiers: [{ employerPct: '100', uptoPct: '4.555' }] }))).toEqual({
      ok: false,
      errors: {
        tiers: 'Enter each percentage with at most two digits after the decimal point, like 4.5.',
      },
    });
  });

  it.each(['0', '101', '4.555', '-4', 'four'])('refuses the percentage %j', (pct) => {
    expect(read(draft({ tiers: [{ employerPct: '100', uptoPct: pct }] })).ok).toBe(false);
  });

  it('refuses a zero salary', () => {
    expect(read(draft({ salary: '0' })).ok).toBe(false);
  });

  it('needs each tier to reach further than the one before', () => {
    const tiers = [
      { employerPct: '100', uptoPct: '5' },
      { employerPct: '50', uptoPct: '3' },
    ];
    expect(read(draft({ tiers }))).toEqual({
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
      salary_pay_stub_id: null,
      start_date: null,
      vesting_years: 3,
    });
    // The stub the salary was compared with goes through too (spec 005 rule 24c).
    expect(
      profileInput({ ...sampleProfile, salary_pay_stub_id: 'stub-1' }).salary_pay_stub_id,
    ).toBe('stub-1');
  });
});

describe('salaryStubId (spec 005 rule 24c)', () => {
  const compared = { ...sampleProfile, salary_pay_stub_id: 'stub-older' };

  it('names the newest stub once the person saves a salary of their own beside it', () => {
    expect(salaryStubId(compared, stub, 6_499_992)).toBe(stub.id);
    // A first salary, typed or taken from the stub.
    expect(salaryStubId(emptyProfile, stub, 6_500_000)).toBe(stub.id);
  });

  it('keeps the stub compared before when the salary is the one already saved', () => {
    // Saving another field never answers an open salary question.
    expect(salaryStubId(compared, stub, 6_500_000)).toBe('stub-older');
    expect(salaryStubId(sampleProfile, stub, 6_500_000)).toBeNull();
  });

  it('names no stub without one', () => {
    expect(salaryStubId(emptyProfile, undefined, 6_500_000)).toBeNull();
    expect(salaryStubId(compared, undefined, 6_499_992)).toBe('stub-older');
  });
});
