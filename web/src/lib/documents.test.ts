import { describe, expect, it } from 'vitest';
import { documentStatusBadge, documentTypeLabel, statusReasonText } from './documents';

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

describe('statusReasonText', () => {
  it('explains each reason in a sentence, and nothing without one', () => {
    expect(statusReasonText(null)).toBeNull();
    expect(statusReasonText('refused')).toMatch(/type the fields yourself/);
    expect(statusReasonText('no_readable_page')).toMatch(/redacted safely/);
    expect(statusReasonText('budget')).toMatch(/limit/);
    expect(statusReasonText('extraction_failed')).toMatch(/type the fields yourself/);
    expect(statusReasonText('unreadable_file')).toMatch(/could not be opened/);
    expect(statusReasonText('expired')).toMatch(/Upload it again/);
  });
});
