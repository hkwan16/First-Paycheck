import type { PayFrequency } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import type { Tone } from '@/lib/design/tone';
import { formatMoney, formatRate } from '@/lib/money';
import type { Choice, ReviewField } from './confirmReducer';

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
  if (value === null) return manual ? 'Not entered yet' : 'None';
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
 * The extraction confidence badge: "Check · 74%" (warning) below 0.9,
 * "Read · 99%" otherwise. A computed field has no confidence ("Added up");
 * typed fields have no badge.
 */
export function confidenceBadge(
  confidence: number | null,
  manual: boolean,
): { label: string; tone: Tone } | null {
  if (manual) return null;
  if (confidence === null) return { label: 'Added up', tone: 'neutral' };
  const pct = `${Math.round(confidence * 100)}%`;
  return confidence < REVIEW_THRESHOLD
    ? { label: `Check · ${pct}`, tone: 'warning' }
    : { label: `Read · ${pct}`, tone: 'blue' };
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
