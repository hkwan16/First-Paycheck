import { describe, expect, it } from 'vitest';
import {
  documentStatusBadge,
  documentTypeLabel,
  linesSentToAi,
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

describe('reasons as past events (spec 004 rule 37, issue 163)', () => {
  it('says what happened when the document was read, never what is true now', () => {
    expect(statusReasonText('no_model')).toBe(
      'The AI was not available when this was read, so nothing was filled in. Read it again, or type the fields from the lines shown.',
    );
    expect(statusReasonText('budget')).toBe(
      'The daily reading limit was used up when this was read, so nothing was filled in. Read it again tomorrow, or type the fields yourself.',
    );
    expect(statusReasonText('extraction_failed')).toBe(
      'Reading did not finish after several tries, so nothing was filled in. Read it again, or type the fields yourself.',
    );
    for (const reason of ['no_model', 'budget', 'extraction_failed'] as const) {
      expect(statusReasonText(reason)).not.toMatch(/right now|is used up|is off/);
    }
  });

  it('knows which lines were sent to the AI', () => {
    expect(linesSentToAi(null)).toBe(true);
    expect(linesSentToAi('refused')).toBe(true);
    expect(linesSentToAi('extraction_failed')).toBe(true);
    expect(linesSentToAi('no_model')).toBe(false);
    expect(linesSentToAi('budget')).toBe(false);
    expect(linesSentToAi('no_readable_page')).toBe(false);
  });
});
