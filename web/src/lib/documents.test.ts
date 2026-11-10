import { describe, expect, it } from 'vitest';
import {
  documentBadge,
  documentStatusBadge,
  documentSubject,
  documentTypeLabel,
  hiddenText,
  statusReasonText,
} from './documents';

describe('documentTypeLabel', () => {
  it('names each type the way the person chose it', () => {
    expect(documentTypeLabel('pay_stub')).toBe('Pay stub');
    expect(documentTypeLabel('offer_letter')).toBe('Offer letter');
    expect(documentTypeLabel('benefits')).toBe('Benefits summary');
  });
});

describe('documentStatusBadge', () => {
  it('gives each status a label and a tone; only a confirmed document is confirmed', () => {
    expect(documentStatusBadge('uploaded')).toEqual({ label: 'Uploaded', tone: 'neutral' });
    expect(documentStatusBadge('extracting')).toEqual({ label: 'Reading', tone: 'blue' });
    expect(documentStatusBadge('proposed')).toEqual({ label: 'Review needed', tone: 'warning' });
    expect(documentStatusBadge('manual_entry_required')).toEqual({
      label: 'Manual entry needed',
      tone: 'warning',
    });
    expect(documentStatusBadge('confirmed')).toEqual({ label: 'Confirmed', tone: 'confirmed' });
    expect(documentStatusBadge('failed')).toEqual({ label: 'Failed', tone: 'off' });
  });
});

describe('documentBadge', () => {
  it('is the status badge, unless a newer copy of the paycheck counts instead (issue 199)', () => {
    expect(documentBadge({ status: 'confirmed', superseded: false })).toEqual({
      label: 'Confirmed',
      tone: 'confirmed',
    });
    expect(documentBadge({ status: 'confirmed', superseded: true })).toEqual({
      label: 'Replaced by a newer copy',
      tone: 'neutral',
    });
  });
});

describe('hiddenText', () => {
  it('counts the numbers hidden before reading, in words', () => {
    expect(hiddenText(0)).toBe('No numbers hidden');
    expect(hiddenText(1)).toBe('1 number hidden');
    expect(hiddenText(1200)).toBe('1,200 numbers hidden');
  });
});

describe('statusReasonText', () => {
  it('explains each reason in a sentence, and nothing without one', () => {
    expect(statusReasonText(null)).toBeNull();
    expect(statusReasonText('refused')).toMatch(/Type the amounts yourself/);
    expect(statusReasonText('no_readable_page')).toMatch(/could not hide the private numbers/);
    expect(statusReasonText('budget')).toMatch(/limit/);
    expect(statusReasonText('extraction_failed')).toMatch(/type the amounts yourself/);
    expect(statusReasonText('unreadable_file')).toMatch(/could not be opened/);
    expect(statusReasonText('expired')).toMatch(/Upload it again/);
  });

  it('never names the machinery behind the reading (issue 209)', () => {
    const reasons = [
      'refused',
      'no_readable_page',
      'budget',
      'extraction_failed',
      'no_model',
      'unreadable_file',
      'expired',
    ] as const;
    for (const reason of reasons) {
      expect(statusReasonText(reason)).not.toMatch(/\bAI\b|model|redact|OCR|fields/);
    }
  });
});

describe('reasons as past events (spec 004 rule 37, issue 163)', () => {
  it('says what happened when the document was read, never what is true now', () => {
    expect(statusReasonText('no_model')).toBe(
      'Automatic reading was not available then, so nothing was filled in. Read it again, or type the amounts yourself.',
    );
    expect(statusReasonText('budget')).toBe(
      'We had reached the daily reading limit, so nothing was filled in. Read it again tomorrow, or type the amounts yourself.',
    );
    expect(statusReasonText('extraction_failed')).toBe(
      'Reading did not finish, so nothing was filled in. Read it again, or type the amounts yourself.',
    );
    for (const reason of ['no_model', 'budget', 'extraction_failed'] as const) {
      expect(statusReasonText(reason)).not.toMatch(/right now|is used up|is off/);
    }
  });
});

describe('documentSubject', () => {
  const nothing = { employer_name: null, pay_date: null, plan_names: [] };

  it('names a confirmed pay stub by its employer and pay date (issue 243)', () => {
    expect(
      documentSubject({ ...nothing, employer_name: 'Acme Corp', pay_date: '2026-10-15' }),
    ).toBe('Acme Corp, paid Oct 15, 2026');
  });

  it('names only the pay date when the stub shows no employer', () => {
    expect(documentSubject({ ...nothing, pay_date: '2026-10-15' })).toBe('paid Oct 15, 2026');
  });

  it('names a confirmed summary by its plans, in order', () => {
    expect(documentSubject({ ...nothing, plan_names: ['Gold PPO'] })).toBe('Gold PPO');
    expect(documentSubject({ ...nothing, plan_names: ['Gold PPO', 'Silver HMO'] })).toBe(
      'Gold PPO and Silver HMO',
    );
    expect(
      documentSubject({ ...nothing, plan_names: ['Gold PPO', 'Silver HMO', 'Bronze HDHP'] }),
    ).toBe('Gold PPO, Silver HMO and Bronze HDHP');
  });

  it('names nothing for a document nothing was confirmed from', () => {
    expect(documentSubject(nothing)).toBeNull();
  });
});
