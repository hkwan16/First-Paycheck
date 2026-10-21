import type { DocumentStatus, DocumentStatusReason, DocumentType } from '@/lib/api/types';
import type { Tone } from '@/lib/design/tone';

/*
 * Words and tones for documents, shared by the Link and Confirm screens and
 * kept pure so the tones can be tested without naming a status color in a
 * screen test.
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
  no_model: 'Automatic reading is off right now, so type the fields from the lines shown.',
  unreadable_file: 'This file could not be opened. Upload it again as a PDF, PNG or JPEG.',
  expired: 'The file was deleted because it was not confirmed within a week. Upload it again.',
};

/** Why a document needs manual entry or failed, as a sentence; null without a reason. */
export const statusReasonText = (reason: DocumentStatusReason | null) =>
  reason === null ? null : REASON[reason];
