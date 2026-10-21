import { describe, expect, it } from 'vitest';
import { sampleRecurring } from '@/test/fixtures/cashflow';
import { cadenceLabel, recurringBadge, renameError, userStatusText } from './recurring-format';

const [HULU, LEMONADE, PARKLINE, , VERIZON] = sampleRecurring;

describe('recurringBadge', () => {
  it('flags what the detector found with the status tones, and leaves active charges neutral', () => {
    expect(recurringBadge(LEMONADE!)).toEqual({ tone: 'warning', text: 'New' });
    expect(recurringBadge(VERIZON!)).toEqual({ tone: 'warning', text: 'Price changed' });
    expect(recurringBadge(HULU!)).toEqual({ tone: 'off', text: 'Stopped' });
    expect(recurringBadge(PARKLINE!)).toEqual({ tone: 'neutral', text: 'Active' });
  });
});

describe('userStatusText', () => {
  it('says what the person marked, if anything', () => {
    expect(userStatusText({ ...PARKLINE!, user_status: 'ignored' })).toBe('Not recurring');
    expect(userStatusText({ ...PARKLINE!, user_status: 'confirmed' })).toBe('You confirmed it');
    expect(userStatusText({ ...HULU!, user_status: 'cancelled' })).toBe('You cancelled it');
    expect(userStatusText(PARKLINE!)).toBeNull();
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
