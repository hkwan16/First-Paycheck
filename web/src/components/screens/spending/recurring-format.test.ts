import { describe, expect, it } from 'vitest';
import type { RecurringCharge } from '@/lib/api/types';
import { sampleRecurring } from '@/test/fixtures/cashflow';
import {
  cadenceLabel,
  recurringBadge,
  renameError,
  type RecurringBadgeView,
} from './recurring-format';

const [HULU, LEMONADE, PARKLINE, , VERIZON] = sampleRecurring;

describe('recurringBadge', () => {
  // Spec 009 rule 19: one badge per row; once the person has marked a charge it says only that.
  const NEW = { tone: 'warning', text: 'New' } as const;
  const CHANGED = { tone: 'warning', text: 'Price changed' } as const;
  const STOPPED = { tone: 'off', text: 'Stopped' } as const;
  const ACTIVE = { tone: 'neutral', text: 'Active' } as const;
  const IGNORED = { tone: 'neutral', text: 'Not recurring' } as const;
  const CONFIRMED = { tone: 'neutral', text: 'You confirmed it' } as const;
  const CANCELLED = { tone: 'neutral', text: 'You cancelled it' } as const;
  const cases: [RecurringCharge['status'], RecurringCharge['user_status'], RecurringBadgeView][] = [
    ['new', null, NEW],
    ['changed', null, CHANGED],
    ['stopped', null, STOPPED],
    ['active', null, ACTIVE],
    ['new', 'ignored', IGNORED],
    ['changed', 'ignored', IGNORED],
    ['stopped', 'ignored', IGNORED],
    ['active', 'ignored', IGNORED],
    ['new', 'confirmed', CONFIRMED],
    ['changed', 'confirmed', CONFIRMED],
    ['stopped', 'confirmed', CONFIRMED],
    ['active', 'confirmed', CONFIRMED],
    ['new', 'cancelled', CANCELLED],
    ['changed', 'cancelled', CANCELLED],
    ['stopped', 'cancelled', CANCELLED],
    ['active', 'cancelled', CANCELLED],
  ];

  it.each(cases)('%s with the mark %s reads %j', (status, userStatus, badge) => {
    expect(recurringBadge({ ...PARKLINE!, status, user_status: userStatus })).toEqual(badge);
  });

  it('reads the sample charges the detector flagged', () => {
    expect(recurringBadge(LEMONADE!)).toEqual({ tone: 'warning', text: 'New' });
    expect(recurringBadge(VERIZON!)).toEqual({ tone: 'warning', text: 'Price changed' });
    expect(recurringBadge(HULU!)).toEqual({ tone: 'off', text: 'Stopped' });
    expect(recurringBadge(PARKLINE!)).toEqual({ tone: 'neutral', text: 'Active' });
  });
});

describe('cadenceLabel', () => {
  it('reads the cadence as a word', () => {
    expect(cadenceLabel('weekly')).toBe('Weekly');
    expect(cadenceLabel('monthly')).toBe('Monthly');
    expect(cadenceLabel('yearly')).toBe('Yearly');
  });
});

describe('renameError', () => {
  it('asks for 1 to 100 characters after trimming, as the API does', () => {
    expect(renameError('   ')).toBe('Enter a name.');
    expect(renameError('x'.repeat(101))).toBe('Use 100 characters or fewer.');
    expect(renameError(` ${'x'.repeat(100)} `)).toBeNull();
    expect(renameError('Netflix')).toBeNull();
  });
});
