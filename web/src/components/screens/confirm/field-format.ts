import type { PayFrequency } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import type { Tone } from '@/lib/design/tone';
import { formatMoney, formatRate } from '@/lib/money';
import { canBeNone, isEntered, type Choice, type ReviewField } from './confirmReducer';

/*
 * Words, tones and layout for the Confirm screen, kept pure so they can be
 * tested on their own (screen tests cannot name status colors).
 */

/** Every `PayFrequency` the API accepts, in the order a person thinks of them. */
export const PAY_FREQUENCY_CHOICES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'monthly', label: 'Monthly' },
] as const satisfies readonly (Choice & { value: PayFrequency })[];

/**
 * Text fields whose value is one of a fixed set, by field key. A key here
 * only changes the input (a select instead of free text); what the fields
 * are, and their order, still comes from the API.
 */
export const FIELD_CHOICES: Readonly<Record<string, readonly Choice[]>> = {
  pay_frequency: PAY_FREQUENCY_CHOICES,
};

/** A field's value as a person reads it. */
export function fieldDisplay(
  field: Pick<ReviewField, 'kind' | 'value' | 'choices'>,
  manual: boolean,
): string {
  const { kind, value } = field;
  // Never "None", which reads as zero (issue 195).
  if (value === null) return manual ? 'Not entered yet' : 'Not found';
  if (kind === 'money' && typeof value === 'number') return formatMoney(value);
  if (kind === 'date' && typeof value === 'string') {
    try {
      return formatDate(value);
    } catch {
      return value;
    }
  }
  if (kind === 'percent') {
    try {
      return formatRate(value);
    } catch {
      return `${value}%`;
    }
  }
  return field.choices?.find((c) => c.value === String(value))?.label ?? String(value);
}

/** Below this the field is marked for a check (spec amendment 12). */
export const REVIEW_THRESHOLD = 0.9;

/**
 * Where the value on screen came from (spec 005 rule 23a), never a score
 * (issue 209): "Your entry" once the person typed a value or confirmed none;
 * otherwise "Check this" (warning) for a value read below 0.9 or for nothing
 * read (issue 230), "Added up" for a computed field, "Read clearly" for the
 * rest. In manual entry every value is typed, so no row has a badge.
 */
export function valueBadge(
  field: Pick<ReviewField, 'confidence' | 'value' | 'proposed'>,
  manual: boolean,
): { label: string; tone: Tone } | null {
  if (manual) return null;
  if (isEntered(field)) return { label: 'Your entry', tone: 'neutral' };
  if (field.value === null) return { label: 'Check this', tone: 'warning' };
  if (field.confidence === null) return { label: 'Added up', tone: 'neutral' };
  return field.confidence < REVIEW_THRESHOLD
    ? { label: 'Check this', tone: 'warning' }
    : { label: 'Read clearly', tone: 'blue' };
}

/**
 * The line under a field: the proposal's note about what was read, until the
 * person enters the value; for a deduction nothing was read for, how to
 * confirm none (spec 005 rule 23b), in the words of the row or of its editor.
 */
export function fieldNote(
  field: Pick<ReviewField, 'kind' | 'role' | 'value' | 'proposed' | 'note'>,
  editing: boolean,
): string | null {
  if (isEntered(field)) return null;
  if (field.value === null && canBeNone(field)) {
    return editing
      ? 'Leave it empty if your stub has no such line.'
      : 'If your stub has no such line, confirm none.';
  }
  return field.note;
}

const REDACTED = '[REDACTED]';
const TRAILING_VALUE = /^(.*?\S)\s+(\$?-?[\d,]*\.\d{2}|-|\[REDACTED\]\S*)$/;
const WIDE_GAP = /^(\S.*?\S)\s{2,}(\S.*)$/;

/**
 * A printed stub line as label and value, so the source pane reads like the
 * stub: a trailing amount, dash or redaction goes right; otherwise a wide gap
 * splits it; otherwise the line stays whole.
 */
export function splitSourceLine(text: string): { label: string; value: string | null } {
  const match = TRAILING_VALUE.exec(text.trim()) ?? WIDE_GAP.exec(text.trim());
  return match ? { label: match[1]!, value: match[2]! } : { label: text.trim(), value: null };
}

/** Text around each `[REDACTED]` mark; a redacted part has no text of its own. */
export function redactionParts(text: string): { redacted: boolean; text: string }[] {
  const parts: { redacted: boolean; text: string }[] = [];
  text.split(REDACTED).forEach((piece, index) => {
    if (index > 0) parts.push({ redacted: true, text: '' });
    if (piece !== '') parts.push({ redacted: false, text: piece });
  });
  return parts;
}
