import type { ProposedField } from '@/lib/api/types';
import { formatMoney, parseMoney } from '@/lib/money';
import { parseISODate } from '@/lib/dates';

/*
 * The Confirm screen's state, ported from the mockup's script
 * (docs/mockup/Confirm.dc.html): select a field, confirm or un-confirm it,
 * edit it as a draft, save (validate and confirm) or cancel, confirm all.
 *
 * Every value is a proposal until the person confirms it, and only confirmed
 * values are sent. The one piece of money arithmetic in the web app is
 * `mathGate`: gross minus deductions minus net, over the person's own entries,
 * so the screen can say whether they add up before the server checks the same
 * thing (and has the final word with a 422). Which fields take part comes from
 * each field's `role`, never from a list of keys.
 */

export type FieldValue = ProposedField['value'];

/** An allowed value for a text field with a fixed set (pay frequency). */
export interface Choice {
  value: string;
  label: string;
}

export interface ReviewField {
  key: string;
  label: string;
  kind: ProposedField['kind'];
  role: ProposedField['role'];
  /** The model's self-reported confidence; null for computed or typed fields. */
  confidence: number | null;
  note: string | null;
  /** Integer cents for money, an ISO date, text, or null for nothing. */
  value: FieldValue;
  confirmed: boolean;
  /** What is being typed, or null when the field is not being edited. */
  draft: string | null;
  /** Why the last save was refused. */
  error: string | null;
  choices?: readonly Choice[];
}

export interface ConfirmState {
  fields: ReviewField[];
  /** The field whose source line is highlighted. */
  selected: string | null;
}

export type ConfirmAction =
  | { type: 'select'; key: string }
  | { type: 'toggle'; key: string }
  | { type: 'edit'; key: string }
  | { type: 'draft'; key: string; text: string }
  | { type: 'save'; key: string }
  | { type: 'cancel'; key: string }
  | { type: 'confirmAll' };

export interface InitOptions {
  /** `manual_entry_required`: every field starts empty and open for typing. */
  manual: boolean;
  /** Fixed options for text fields, by key. */
  choices?: Readonly<Record<string, readonly Choice[]>>;
}

export function initConfirmState(
  fields: readonly ProposedField[],
  options: InitOptions,
): ConfirmState {
  const review = fields.map<ReviewField>((f) => ({
    key: f.key,
    label: f.label,
    kind: f.kind,
    role: f.role,
    confidence: options.manual ? null : f.confidence,
    note: options.manual ? null : f.note,
    value: options.manual ? null : f.value,
    confirmed: false,
    draft: options.manual ? '' : null,
    error: null,
    ...(options.choices?.[f.key] ? { choices: options.choices[f.key] } : {}),
  }));
  const first = review.find((f) => f.role === 'gross') ?? review[0];
  return { fields: review, selected: first?.key ?? null };
}

const MONEY_ERROR = 'Enter an amount, like 1,234.56';
const DATE_ERROR = 'Enter a date';

/** Amounts and dates must be there to confirm; text may be left empty. */
const isRequired = (f: Pick<ReviewField, 'kind'>) => f.kind === 'money' || f.kind === 'date';

const hasWhatItNeeds = (f: ReviewField) => f.value !== null || !isRequired(f);

/** The text the editor opens with. */
export function draftText(f: Pick<ReviewField, 'kind' | 'value'>): string {
  if (f.value === null) return '';
  if (f.kind === 'money' && typeof f.value === 'number')
    return formatMoney(f.value).replace('$', '');
  return String(f.value);
}

type Parsed = { ok: true; value: FieldValue } | { ok: false; error: string };

const isISODate = (text: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  try {
    parseISODate(text);
    return true;
  } catch {
    return false;
  }
};

/** A draft as the value it will be sent as, or why it cannot be. */
export function parseDraft(f: Pick<ReviewField, 'kind' | 'choices'>, text: string): Parsed {
  const trimmed = text.trim();
  switch (f.kind) {
    case 'money': {
      const cents = parseMoney(trimmed);
      if (cents === null) return { ok: false, error: MONEY_ERROR };
      if (cents < 0) return { ok: false, error: "An amount can't be negative" };
      return { ok: true, value: cents };
    }
    case 'date':
      return isISODate(trimmed) ? { ok: true, value: trimmed } : { ok: false, error: DATE_ERROR };
    case 'percent':
      return /^\d{1,3}(\.\d{1,2})?$/.test(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false, error: 'Enter a percentage, like 20 or 12.5' };
    case 'text':
      if (trimmed === '') return { ok: true, value: null };
      if (f.choices && !f.choices.some((c) => c.value === trimmed)) {
        return { ok: false, error: 'Choose one of the options' };
      }
      return { ok: true, value: trimmed };
  }
}

const requiredError = (f: ReviewField) => (f.kind === 'money' ? MONEY_ERROR : DATE_ERROR);

function patch(
  state: ConfirmState,
  key: string,
  change: (f: ReviewField) => ReviewField,
): ConfirmState {
  if (!state.fields.some((f) => f.key === key)) return state;
  return { ...state, fields: state.fields.map((f) => (f.key === key ? change(f) : f)) };
}

export function confirmReducer(state: ConfirmState, action: ConfirmAction): ConfirmState {
  switch (action.type) {
    case 'select':
      return state.fields.some((f) => f.key === action.key)
        ? { ...state, selected: action.key }
        : state;

    case 'toggle':
      return patch(state, action.key, (f) => {
        if (f.confirmed) return { ...f, confirmed: false };
        // Nothing to confirm yet: open the editor and say what is missing.
        if (!hasWhatItNeeds(f)) return { ...f, draft: '', error: requiredError(f) };
        return { ...f, confirmed: true, draft: null, error: null };
      });

    case 'edit': {
      const next = patch(state, action.key, (f) => ({ ...f, draft: draftText(f), error: null }));
      return next === state ? state : { ...next, selected: action.key };
    }

    case 'draft':
      return patch(state, action.key, (f) =>
        f.draft === null ? f : { ...f, draft: action.text, error: null },
      );

    case 'save':
      return patch(state, action.key, (f) => {
        if (f.draft === null) return f;
        const parsed = parseDraft(f, f.draft);
        if (!parsed.ok) return { ...f, error: parsed.error };
        if (parsed.value === null && isRequired(f)) return { ...f, error: requiredError(f) };
        return { ...f, value: parsed.value, confirmed: true, draft: null, error: null };
      });

    case 'cancel':
      // The value and the confirmed state were never touched by the edit.
      return patch(state, action.key, (f) => ({ ...f, draft: null, error: null }));

    case 'confirmAll':
      return {
        ...state,
        fields: state.fields.map((f) =>
          f.draft === null && hasWhatItNeeds(f) ? { ...f, confirmed: true, error: null } : f,
        ),
      };
  }
}

export type Gate =
  /** Gross minus every deduction equals net, to the cent. */
  | { status: 'ok' }
  /** Off by `differenceCents` = gross - deductions - net. */
  | { status: 'off'; differenceCents: number }
  /** "?": an amount that takes part is being typed and is not an amount, or is missing. */
  | { status: 'unknown'; reason: 'invalid' | 'missing'; label: string }
  /** No gross and net fields: nothing to check. */
  | { status: 'none' };

/**
 * The arithmetic gate over the person's entries (an open draft counts as
 * typed, so the result follows the keyboard). Display-side only: the server
 * runs the same check on confirm and its 422 is the authority.
 */
export function mathGate(fields: readonly ReviewField[]): Gate {
  const taking = fields.filter(
    (f) => f.kind === 'money' && (f.role === 'gross' || f.role === 'deduction' || f.role === 'net'),
  );
  if (!taking.some((f) => f.role === 'gross') || !taking.some((f) => f.role === 'net')) {
    return { status: 'none' };
  }
  let difference = 0;
  for (const f of taking) {
    let cents: number | null;
    if (f.draft !== null && f.draft.trim() === '') {
      cents = null;
    } else if (f.draft !== null) {
      const parsed = parseDraft(f, f.draft);
      if (!parsed.ok) return { status: 'unknown', reason: 'invalid', label: f.label };
      cents = parsed.value as number | null;
    } else {
      cents = typeof f.value === 'number' ? f.value : null;
    }
    if (cents === null) return { status: 'unknown', reason: 'missing', label: f.label };
    difference += f.role === 'gross' ? cents : -cents;
  }
  return difference === 0 ? { status: 'ok' } : { status: 'off', differenceCents: difference };
}

export interface ConfirmSummary {
  total: number;
  confirmedCount: number;
  remaining: number;
  /** Whole percent of fields confirmed, for the progress bar. */
  progressPct: number;
  /** Fields with an open editor. */
  editing: number;
  gate: Gate;
  /** Every field confirmed, nothing being typed, and the math checks out (or has nothing to check). */
  canContinue: boolean;
}

export function summarize(state: ConfirmState): ConfirmSummary {
  const total = state.fields.length;
  const confirmedCount = state.fields.filter((f) => f.confirmed).length;
  const editing = state.fields.filter((f) => f.draft !== null).length;
  const gate = mathGate(state.fields);
  return {
    total,
    confirmedCount,
    remaining: total - confirmedCount,
    progressPct: total === 0 ? 0 : Math.round((confirmedCount / total) * 100),
    editing,
    gate,
    canContinue:
      total > 0 &&
      confirmedCount === total &&
      editing === 0 &&
      (gate.status === 'ok' || gate.status === 'none'),
  };
}

/** The confirmed values under their keys, the body `POST /docs/{id}/confirm` takes. */
export function payStubValues(fields: readonly ReviewField[]): Record<string, FieldValue> {
  return Object.fromEntries(fields.map((f) => [f.key, f.value]));
}
