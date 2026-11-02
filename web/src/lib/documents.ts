import type {
  DocumentStatus,
  DocumentStatusReason,
  DocumentSummary,
  DocumentType,
} from '@/lib/api/types';
import type { Tone } from '@/lib/design/tone';
import { formatNumber } from '@/lib/money';

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

/** A confirmed copy a newer confirm of the same paycheck took the place of (spec 005 rule 22f). */
const SUPERSEDED_BADGE = { label: 'Replaced by a newer copy', tone: 'neutral' } as const;

/** What a document's row says it is: its status, unless a newer copy counts instead. */
export const documentBadge = (document: Pick<DocumentSummary, 'status' | 'superseded'>) =>
  document.superseded ? SUPERSEDED_BADGE : STATUS_BADGE[document.status];

/** The sentence under a superseded copy's row and on its Confirm page. */
export const SUPERSEDED_TEXT = 'You confirmed this paycheck again, so the newer copy counts.';

/** "2 numbers hidden": what redaction blacked out before the document was read. */
export function hiddenText(count: number): string {
  if (count === 0) return 'No numbers hidden';
  return `${formatNumber(count)} ${count === 1 ? 'number' : 'numbers'} hidden`;
}

/*
 * Each reason is something that happened when the document was read (spec 004
 * rule 37), so it is said in the past: "was not available then", never "is
 * off right now", which stops being true once reading is back. The reasons
 * that were about the reading, not the document, offer Read again; the API
 * says when it applies (`can_read_again`).
 */
const REASON: Record<DocumentStatusReason, string> = {
  refused: 'We could not read this document automatically. Type the amounts yourself.',
  no_readable_page:
    'We could not hide the private numbers on any page, so we did not read it. Type the amounts yourself.',
  budget:
    'We had reached the daily reading limit, so nothing was filled in. Read it again tomorrow, or type the amounts yourself.',
  extraction_failed:
    'Reading did not finish, so nothing was filled in. Read it again, or type the amounts yourself.',
  no_model:
    'Automatic reading was not available then, so nothing was filled in. Read it again, or type the amounts yourself.',
  unreadable_file: 'This file could not be opened. Upload it again as a PDF, PNG or JPEG.',
  expired: 'We deleted the file because it was not confirmed within a week. Upload it again.',
};

/** Why a document needs manual entry or failed, as a sentence; null without a reason. */
export const statusReasonText = (reason: DocumentStatusReason | null) =>
  reason === null ? null : REASON[reason];
