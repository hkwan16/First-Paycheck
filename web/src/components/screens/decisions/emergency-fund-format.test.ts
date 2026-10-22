import { describe, expect, it } from 'vitest';
import { sampleCashflow } from '@/test/fixtures/cashflow';
import { sampleGoal, sampleEmergencyFund } from '@/test/fixtures/planning';
import { sampleAccounts } from '@/test/fixtures/sample';
import {
  accountName,
  emergencyAccount,
  essentialsPrefill,
  fundBarTone,
  fundHeadline,
  goalStatusBadge,
  monthsText,
} from './emergency-fund-format';

const result = (overrides: Parameters<typeof sampleEmergencyFund>[0] = {}) =>
  sampleEmergencyFund(overrides).result;

describe('monthsText', () => {
  it('counts months, and whole years when the count is a multiple of twelve', () => {
    expect(monthsText(1)).toBe('1 month');
    expect(monthsText(12)).toBe('12 months');
    expect(monthsText(12, { years: true })).toBe('1 year');
    expect(monthsText(120, { years: true })).toBe('10 years');
    expect(monthsText(15, { years: true })).toBe('15 months');
  });
});

describe('fundHeadline', () => {
  it('names the target and how many monthly contributions reach it', () => {
    expect(fundHeadline(result())).toBe('Target $5,470, reached in 12 months');
  });

  it('says when the contribution does not reach it within the horizon', () => {
    expect(fundHeadline(result({ monthly_contribution_cents: 1_000 }))).toBe(
      'Target $5,470, not within 10 years at this amount',
    );
    expect(fundHeadline(result({ monthly_contribution_cents: 0 }))).toBe(
      'Target $5,470, not within 10 years at this amount',
    );
  });

  it('says when the savings already cover the target', () => {
    expect(fundHeadline(result({ current_balance_cents: 600_000 }))).toBe(
      'Your savings already cover the $5,470 target',
    );
  });
});

describe('fundBarTone', () => {
  it('is the emergency fund hue until funded, then confirmed', () => {
    expect(fundBarTone(result())).toBe('teal');
    expect(fundBarTone(result({ current_balance_cents: 600_000 }))).toBe('confirmed');
  });
});

describe('goalStatusBadge', () => {
  it('words and tones each status', () => {
    expect(goalStatusBadge('active')).toEqual({ label: 'Active', tone: 'teal' });
    expect(goalStatusBadge('paused')).toEqual({ label: 'Paused', tone: 'neutral' });
    expect(goalStatusBadge('reached')).toEqual({ label: 'Reached', tone: 'confirmed' });
    expect(sampleGoal().status).toBe('active');
  });
});

describe('essentialsPrefill', () => {
  it("is the summary's essentials when it has some", () => {
    expect(essentialsPrefill(sampleCashflow().spending)).toBe(182_325);
  });

  it('is null without a summary or with no essential spending in it', () => {
    expect(essentialsPrefill(undefined)).toBeNull();
    expect(essentialsPrefill({ ...sampleCashflow().spending, essentials_cents: 0 })).toBeNull();
    expect(essentialsPrefill({ ...sampleCashflow().spending, essentials_cents: -500 })).toBeNull();
  });
});

describe('accountName', () => {
  it('names an account with its last digits when it has them', () => {
    expect(accountName(sampleAccounts[1]!)).toBe('Chase Savings ··7730');
    expect(accountName({ name: 'Cash', mask: null })).toBe('Cash');
  });
});

describe('emergencyAccount', () => {
  it('is the active account marked as the emergency fund', () => {
    expect(emergencyAccount(sampleAccounts)?.name).toBe('Chase Savings');
  });

  it('is null when no active account has that role', () => {
    const [checking, savings] = sampleAccounts;
    expect(emergencyAccount([checking!])).toBeNull();
    expect(emergencyAccount([{ ...savings!, is_active: false }])).toBeNull();
    expect(emergencyAccount(undefined)).toBeNull();
  });
});
