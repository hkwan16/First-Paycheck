import { describe, expect, it } from 'vitest';
import { UploadError } from '@/lib/api/upload';
import {
  documentStatusBadge,
  documentTypeLabel,
  formatWait,
  rejectedFileMessage,
  statusReasonText,
  uploadErrorMessage,
} from './document-format';

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

describe('formatWait', () => {
  it('rounds up to a phrase a person can act on', () => {
    expect(formatWait(1)).toBe('in 1 second');
    expect(formatWait(45)).toBe('in 45 seconds');
    expect(formatWait(60)).toBe('in about 1 minute');
    expect(formatWait(61)).toBe('in about 2 minutes');
    expect(formatWait(1200)).toBe('in about 20 minutes');
    expect(formatWait(3600)).toBe('in about 1 hour');
    expect(formatWait(5400)).toBe('in about 2 hours');
    expect(formatWait(0)).toBe('now');
    expect(formatWait(null)).toBe('later');
  });
});

const failed = (status: number, body: unknown = null, retryAfter: number | null = null) =>
  new UploadError(status, body, retryAfter);

describe('uploadErrorMessage', () => {
  it('says a file is too large with the limit the API gives', () => {
    expect(
      uploadErrorMessage(
        'scan.pdf',
        failed(413, {
          error: { code: 'file_too_large', message: 'The file is larger than 10 MB' },
        }),
      ),
    ).toBe('scan.pdf was not uploaded. The file is larger than 10 MB. Try a smaller scan.');
  });

  it('names the types it can read for a 415', () => {
    expect(
      uploadErrorMessage(
        'photo.heic',
        failed(415, {
          error: { code: 'unsupported_media_type', message: 'Upload a PDF, PNG or JPEG' },
        }),
      ),
    ).toBe('photo.heic was not uploaded. Upload a PDF, PNG or JPEG.');
  });

  it('says when to try again after a 429', () => {
    const body = { error: { code: 'rate_limited', message: 'Too many requests' } };
    expect(uploadErrorMessage('acme.pdf', failed(429, body, 1200))).toBe(
      'acme.pdf was not uploaded. You have reached the upload limit for now. Try again in about 20 minutes.',
    );
    expect(uploadErrorMessage('acme.pdf', failed(429, body))).toBe(
      'acme.pdf was not uploaded. You have reached the upload limit for now. Try again later.',
    );
  });

  it('asks to check the connection when nothing answered', () => {
    expect(uploadErrorMessage('acme.pdf', failed(0))).toBe(
      'acme.pdf was not uploaded. Check your connection and try again.',
    );
  });

  it("passes on the API's sentence otherwise", () => {
    expect(
      uploadErrorMessage(
        'acme.pdf',
        failed(422, { error: { code: 'empty_file', message: 'The file is empty' } }),
      ),
    ).toBe('acme.pdf was not uploaded. The file is empty.');
    expect(uploadErrorMessage('acme.pdf', new TypeError('boom'))).toBe(
      'acme.pdf was not uploaded. Try again.',
    );
  });
});

describe('rejectedFileMessage', () => {
  it('names the file and the types it can read', () => {
    expect(rejectedFileMessage('notes.docx')).toBe(
      'notes.docx was not uploaded. Upload a PDF, PNG or JPEG.',
    );
  });
});
