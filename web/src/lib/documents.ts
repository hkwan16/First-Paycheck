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

/*
 * Each reason is something that happened when the document was read (spec 004
 * rule 37), so it is said in the past: "was not available", never "is off
 * right now", which stops being true once the model is back. The reasons that
 * were about the reading, not the document, offer Read again; the API says
 * when it applies (`can_read_again`).
 */
const REASON: Record<DocumentStatusReason, string> = {
  refused: 'The AI declined to read this document, so type the fields yourself.',
  no_readable_page:
    'No page could be redacted safely, so none was sent to the AI. Type the fields yourself.',
  budget:
    'The daily reading limit was used up when this was read, so nothing was filled in. Read it again tomorrow, or type the fields yourself.',
  extraction_failed:
    'Reading did not finish after several tries, so nothing was filled in. Read it again, or type the fields yourself.',
  no_model:
    'The AI was not available when this was read, so nothing was filled in. Read it again, or type the fields from the lines shown.',
  unreadable_file: 'This file could not be opened. Upload it again as a PDF, PNG or JPEG.',
  expired: 'The file was deleted because it was not confirmed within a week. Upload it again.',
};

/** Why a document needs manual entry or failed, as a sentence; null without a reason. */
export const statusReasonText = (reason: DocumentStatusReason | null) =>
  reason === null ? null : REASON[reason];

/**
 * Whether the redacted lines were sent to the model. Without a model or with
 * the budget spent the call never left (no gateway, or refused before any
 * HTTP), and with no readable page nothing was sent; a refusal and failed
 * attempts did send them.
 */
const SENT: Record<DocumentStatusReason, boolean> = {
  refused: true,
  extraction_failed: true,
  no_model: false,
  budget: false,
  no_readable_page: false,
  unreadable_file: false,
  expired: false,
};

/** True when the source lines are what the AI saw (a proposal has no reason). */
export const linesSentToAi = (reason: DocumentStatusReason | null) =>
  reason === null || SENT[reason];
