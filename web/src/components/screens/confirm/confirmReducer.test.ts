import { describe, expect, it } from 'vitest';
import type { ProposedField } from '@/lib/api/types';
import { manualEntryProposal, sampleFields, sampleValues } from '@/test/fixtures/documents';
import {
  confirmReducer,
  initConfirmState,
  mathGate,
  payStubValues,
  summarize,
  type ConfirmAction,
  type ConfirmState,
} from './confirmReducer';

const FREQUENCIES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'semimonthly', label: 'Twice a month' },
] as const;

const proposed = () =>
  initConfirmState([...sampleFields], { manual: false, choices: { pay_frequency: FREQUENCIES } });

const manual = () =>
  initConfirmState([...(manualEntryProposal.fields ?? [])], {
    manual: true,
    choices: { pay_frequency: FREQUENCIES },
  });

const run = (state: ConfirmState, ...actions: ConfirmAction[]) =>
  actions.reduce(confirmReducer, state);

const field = (state: ConfirmState, key: string) => {
  const found = state.fields.find((f) => f.key === key);
  if (!found) throw new Error(`no field ${key}`);
  return found;
};

describe('initConfirmState', () => {
  it('starts every proposed field unconfirmed and closed, with gross pay selected', () => {
    const state = proposed();
    expect(state.fields).toHaveLength(14);
    expect(state.fields.every((f) => !f.confirmed && f.draft === null && f.error === null)).toBe(
      true,
    );
    expect(state.selected).toBe('gross_cents');
    expect(field(state, 'pay_frequency').choices).toEqual(FREQUENCIES);
  });

  it('opens every field for typing when the document needs manual entry', () => {
    const state = manual();
    expect(state.fields.every((f) => f.value === null && f.draft === '')).toBe(true);
    expect(state.fields.every((f) => !f.confirmed)).toBe(true);
    expect(state.selected).toBe('gross_cents');
  });
});

describe('confirmReducer', () => {
  it('selects a field', () => {
    expect(run(proposed(), { type: 'select', key: 'net_cents' }).selected).toBe('net_cents');
  });

  it('toggles a field confirmed and back', () => {
    const once = run(proposed(), { type: 'toggle', key: 'gross_cents' });
    expect(field(once, 'gross_cents').confirmed).toBe(true);
    const twice = run(once, { type: 'toggle', key: 'gross_cents' });
    expect(field(twice, 'gross_cents').confirmed).toBe(false);
  });

  it('confirms an empty optional text field as it is', () => {
    const state = run(
      initConfirmState(
        sampleFields.map((f) => (f.key === 'employer_name' ? { ...f, value: null } : f)),
        { manual: false },
      ),
      { type: 'toggle', key: 'employer_name' },
    );
    expect(field(state, 'employer_name')).toMatchObject({ confirmed: true, value: null });
  });

  it('opens the editor instead of confirming an empty amount or date', () => {
    const empty = initConfirmState(
      sampleFields.map((f) =>
        f.key === 'gross_cents' || f.key === 'pay_date' ? { ...f, value: null } : f,
      ),
      { manual: false },
    );
    const state = run(
      empty,
      { type: 'toggle', key: 'gross_cents' },
      { type: 'toggle', key: 'pay_date' },
    );
    expect(field(state, 'gross_cents')).toMatchObject({
      confirmed: false,
      draft: '',
      error: 'Enter an amount, like 1,234.56',
    });
    expect(field(state, 'pay_date')).toMatchObject({
      confirmed: false,
      draft: '',
      error: 'Enter a date',
    });
  });

  it('edit opens a draft from the current value and selects the field', () => {
    const state = run(proposed(), { type: 'edit', key: 'net_cents' });
    expect(field(state, 'net_cents').draft).toBe('1,996.04');
    expect(state.selected).toBe('net_cents');
    expect(field(run(proposed(), { type: 'edit', key: 'pay_date' }), 'pay_date').draft).toBe(
      '2026-10-15',
    );
    expect(
      field(run(proposed(), { type: 'edit', key: 'employer_name' }), 'employer_name').draft,
    ).toBe('Acme Corp');
  });

  it('save validates the draft, stores cents and confirms', () => {
    const state = run(
      proposed(),
      { type: 'edit', key: 'net_cents' },
      { type: 'draft', key: 'net_cents', text: '$1,996.06' },
      { type: 'save', key: 'net_cents' },
    );
    expect(field(state, 'net_cents')).toMatchObject({
      value: 199_606,
      confirmed: true,
      draft: null,
      error: null,
    });
  });

  it('save keeps the editor open with a reason when the draft is not valid', () => {
    const bad = (key: string, text: string) =>
      field(
        run(proposed(), { type: 'edit', key }, { type: 'draft', key, text }, { type: 'save', key }),
        key,
      );
    expect(bad('net_cents', '12.345')).toMatchObject({
      draft: '12.345',
      error: 'Enter an amount, like 1,234.56',
      value: 199_604,
      confirmed: false,
    });
    expect(bad('net_cents', '-5.00').error).toBe("An amount can't be negative");
    expect(bad('pay_date', '2026-02-30').error).toBe('Enter a date');
    expect(bad('pay_frequency', 'fortnightly').error).toBe('Choose one of the options');
  });

  it('saves an empty optional text field as nothing', () => {
    const state = run(
      proposed(),
      { type: 'edit', key: 'employer_name' },
      { type: 'draft', key: 'employer_name', text: '   ' },
      { type: 'save', key: 'employer_name' },
    );
    expect(field(state, 'employer_name')).toMatchObject({ value: null, confirmed: true });
  });

  it('a new draft clears the last error', () => {
    const state = run(
      proposed(),
      { type: 'edit', key: 'net_cents' },
      { type: 'draft', key: 'net_cents', text: 'x' },
      { type: 'save', key: 'net_cents' },
      { type: 'draft', key: 'net_cents', text: '1' },
    );
    expect(field(state, 'net_cents').error).toBeNull();
  });

  it('cancel restores the value and the confirmed state before the edit', () => {
    const confirmed = run(proposed(), { type: 'toggle', key: 'net_cents' });
    const state = run(
      confirmed,
      { type: 'edit', key: 'net_cents' },
      { type: 'draft', key: 'net_cents', text: '5' },
      { type: 'cancel', key: 'net_cents' },
    );
    expect(field(state, 'net_cents')).toMatchObject({
      value: 199_604,
      confirmed: true,
      draft: null,
      error: null,
    });
  });

  it('confirm-all confirms every closed field that has what it needs, and leaves drafts alone', () => {
    const empty = initConfirmState(
      sampleFields.map((f) => (f.key === 'pay_date' ? { ...f, value: null } : f)),
      { manual: false },
    );
    const state = run(
      empty,
      { type: 'edit', key: 'net_cents' },
      { type: 'draft', key: 'net_cents', text: '1' },
      { type: 'confirmAll' },
    );
    expect(state.fields.filter((f) => f.confirmed).map((f) => f.key)).toEqual(
      sampleFields.map((f) => f.key).filter((k) => k !== 'pay_date' && k !== 'net_cents'),
    );
    expect(field(state, 'net_cents').draft).toBe('1');
  });

  it('ignores actions for a field it does not have', () => {
    const state = proposed();
    expect(run(state, { type: 'toggle', key: 'nope' })).toEqual(state);
  });
});

describe('summarize', () => {
  it('counts confirmed fields and the progress', () => {
    const none = summarize(proposed());
    expect(none).toMatchObject({ total: 14, confirmedCount: 0, remaining: 14, progressPct: 0 });
    expect(none.canContinue).toBe(false);

    const some = summarize(
      run(proposed(), { type: 'toggle', key: 'gross_cents' }, { type: 'toggle', key: 'net_cents' }),
    );
    expect(some).toMatchObject({ confirmedCount: 2, remaining: 12, progressPct: 14 });
  });

  it('offers confirm-all only while some closed field can be confirmed', () => {
    expect(summarize(proposed()).canConfirmAll).toBe(true);
    expect(summarize(run(proposed(), { type: 'confirmAll' })).canConfirmAll).toBe(false);
    expect(summarize(manual()).canConfirmAll).toBe(false);
  });

  it('can continue once every field is confirmed, the math checks out and no draft is open', () => {
    const all = run(proposed(), { type: 'confirmAll' });
    expect(summarize(all)).toMatchObject({
      confirmedCount: 14,
      progressPct: 100,
      canContinue: true,
    });

    const editing = run(all, { type: 'edit', key: 'medicare_cents' });
    expect(summarize(editing).canContinue).toBe(false);

    const off = run(
      all,
      { type: 'edit', key: 'net_cents' },
      { type: 'draft', key: 'net_cents', text: '1,996.06' },
      { type: 'save', key: 'net_cents' },
    );
    expect(summarize(off)).toMatchObject({ confirmedCount: 14, canContinue: false });
  });
});

describe('mathGate', () => {
  const state = proposed();

  it('checks out on the sample stub', () => {
    expect(mathGate(state.fields)).toEqual({ status: 'ok' });
  });

  it('is off by $0.02 after an edit, with the sign of gross minus deductions minus net', () => {
    const edited = run(
      state,
      { type: 'edit', key: 'net_cents' },
      { type: 'draft', key: 'net_cents', text: '1,996.06' },
      { type: 'save', key: 'net_cents' },
    );
    expect(mathGate(edited.fields)).toEqual({ status: 'off', differenceCents: -2 });
  });

  it('reads an open draft as the person types', () => {
    const typing = run(
      state,
      { type: 'edit', key: 'medicare_cents' },
      { type: 'draft', key: 'medicare_cents', text: '39.37' },
    );
    expect(mathGate(typing.fields)).toEqual({ status: 'off', differenceCents: -10 });
  });

  it('is "?" while a draft is not a valid amount', () => {
    const typing = run(
      state,
      { type: 'edit', key: 'gross_cents' },
      { type: 'draft', key: 'gross_cents', text: '2,708.3x' },
    );
    expect(mathGate(typing.fields)).toEqual({
      status: 'unknown',
      reason: 'invalid',
      label: 'Gross pay',
    });
  });

  it('is "?" while an amount is missing', () => {
    expect(mathGate(manual().fields)).toEqual({
      status: 'unknown',
      reason: 'missing',
      label: 'Gross pay',
    });
  });

  it("takes the participating fields from each field's role, not from their keys", () => {
    const renamed: ProposedField[] = [
      {
        key: 'a',
        label: 'A',
        kind: 'money',
        role: 'gross',
        value: 1_000,
        confidence: 1,
        note: null,
      },
      {
        key: 'b',
        label: 'B',
        kind: 'money',
        role: 'deduction',
        value: 300,
        confidence: 1,
        note: null,
      },
      {
        key: 'c',
        label: 'C',
        kind: 'money',
        role: 'info',
        value: 999_999,
        confidence: 1,
        note: null,
      },
      { key: 'd', label: 'D', kind: 'money', role: 'net', value: 700, confidence: 1, note: null },
    ];
    expect(mathGate(initConfirmState(renamed, { manual: false }).fields)).toEqual({ status: 'ok' });
    expect(
      mathGate(
        initConfirmState(
          renamed.map((f) => (f.key === 'c' ? { ...f, role: 'deduction' } : f)),
          { manual: false },
        ).fields,
      ),
    ).toEqual({ status: 'off', differenceCents: -999_999 });
  });

  it('has nothing to check without gross and net fields', () => {
    expect(
      mathGate(
        initConfirmState(
          sampleFields.filter((f) => f.role === 'info'),
          { manual: false },
        ).fields,
      ),
    ).toEqual({ status: 'none' });
  });
});

describe('payStubValues', () => {
  it('sends each field under its key with its confirmed value', () => {
    expect(payStubValues(run(proposed(), { type: 'confirmAll' }).fields)).toEqual(sampleValues);
  });
});
