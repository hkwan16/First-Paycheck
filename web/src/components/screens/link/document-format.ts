import { apiErrorMessage } from '@/lib/api/errors';
import type { DocumentStatus, DocumentStatusReason, DocumentType } from '@/lib/api/types';
import { UploadError } from '@/lib/api/upload';
import type { Tone } from '@/lib/design/tone';

/*
 * Words and tones for the Link screen's documents card, kept pure so the
 * tones can be tested without naming a status color in a screen test.
 */

const TYPE_LABEL: Record<DocumentType, string> = {
  pay_stub: 'Pay stub',
  offer_letter: 'Offer letter',
  benefits: 'Benefits summary',
};

export const documentTypeLabel = (type: DocumentType) => TYPE_LABEL[type];

const STATUS_BADGE: Record<DocumentStatus, { label: string; tone: Tone }> = {
  uploaded: { label: 'Uploaded', tone: 'neutral' },
  extracting: { label: 'Reading', tone: 'blue' },
  proposed: { label: 'Review needed', tone: 'warning' },
  manual_entry_required: { label: 'Manual entry needed', tone: 'warning' },
  // Green means confirmed, so only a confirmed document is green.
  confirmed: { label: 'Confirmed', tone: 'confirmed' },
  failed: { label: 'Failed', tone: 'off' },
};

export const documentStatusBadge = (status: DocumentStatus) => STATUS_BADGE[status];

const REASON: Record<DocumentStatusReason, string> = {
  refused: 'The AI declined to read this document, so type the fields yourself.',
  no_readable_page:
    'No page could be redacted safely, so none was sent to the AI. Type the fields yourself.',
  budget: "Today's reading limit is used up. Type the fields yourself, or try again tomorrow.",
  extraction_failed: 'Reading did not finish after several tries, so type the fields yourself.',
  unreadable_file: 'This file could not be opened. Upload it again as a PDF, PNG or JPEG.',
  expired: 'The file was deleted because it was not confirmed within a week. Upload it again.',
};

/** Why a document needs manual entry or failed, as a sentence; null without a reason. */
export const statusReasonText = (reason: DocumentStatusReason | null) =>
  reason === null ? null : REASON[reason];

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "in about 20 minutes", from a Retry-After in seconds; "later" when unknown. */
export function formatWait(seconds: number | null): string {
  if (seconds === null) return 'later';
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${plural(seconds, 'second')}`;
  if (seconds < 3600) return `in about ${plural(Math.ceil(seconds / 60), 'minute')}`;
  return `in about ${plural(Math.ceil(seconds / 3600), 'hour')}`;
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const ACCEPTED = 'Upload a PDF, PNG or JPEG.';

/** A warning for a failed upload, naming the file and what to do next. */
export function uploadErrorMessage(name: string, error: unknown): string {
  const lead = `${name} was not uploaded.`;
  const status = error instanceof UploadError ? error.status : null;
  switch (status) {
    case 0:
      return `${lead} Check your connection and try again.`;
    case 413:
      return `${lead} ${sentence(apiErrorMessage(error, 'The file is too large'))} Try a smaller scan.`;
    case 415:
      return `${lead} ${sentence(apiErrorMessage(error, ACCEPTED))}`;
    case 429: {
      const wait = formatWait((error as UploadError).retryAfterSeconds);
      return `${lead} You have reached the upload limit for now. Try again ${wait}.`;
    }
    default:
      return `${lead} ${sentence(apiErrorMessage(error, 'Try again'))}`;
  }
}

/** A dropped file the picker would not have offered. */
export const rejectedFileMessage = (name: string) => `${name} was not uploaded. ${ACCEPTED}`;
