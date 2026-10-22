'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { FieldError } from '@/components/ui/FieldError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Notice } from '@/components/ui/Notice';
import { Seg } from '@/components/ui/Seg';
import { Select } from '@/components/ui/Select';
import { useUpdateProfile } from '@/lib/api/hooks';
import { apiErrorMessage } from '@/lib/api/errors';
import type { FilingStatus, PayFrequency, PayStub, Profile } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { examplePlaceholder } from './decision-format';
import {
  BIRTH_YEAR_EXAMPLE,
  draftFromProfile,
  MAX_TIERS,
  profileInput,
  readPlanDetails,
  SALARY_EXAMPLE,
  salaryFromStub,
  type PlanDetailsDraft,
  type PlanDetailsField,
  type TierDraft,
} from './plan-details';

const FILING_STATUSES = [
  { value: 'single', label: 'Single' },
  { value: 'married_filing_jointly', label: 'Married filing jointly' },
  { value: 'head_of_household', label: 'Head of household' },
] as const satisfies readonly { value: FilingStatus; label: string }[];

const PAY_FREQUENCIES: readonly { value: PayFrequency; label: string }[] = [
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'monthly', label: 'Once a month' },
];

export interface PlanDetailsFormProps {
  profile: Profile;
  payStub: PayStub | undefined;
  /** Called once the profile is saved. */
  onSaved: () => void;
  /** Shown as Cancel when the profile already has everything (changing it). */
  onCancel?: () => void;
}

/**
 * What the 401(k) calculator needs that the pay stub does not say: salary,
 * filing status, the employer's match formula and the birth year (and the
 * pay schedule if the stub left it out). Saved to the profile with PUT
 * /profile, which the API validates again, so each is asked for once.
 */
export function PlanDetailsForm({ profile, payStub, onSaved, onCancel }: PlanDetailsFormProps) {
  const id = useId();
  const [draft, setDraft] = useState<PlanDetailsDraft>(() => draftFromProfile(profile, payStub));
  const [errors, setErrors] = useState<Partial<Record<PlanDetailsField, string>>>({});
  const [askFrequency] = useState(() => draft.payFrequency === null);
  // Where the starting salary came from, while it is still the stub's.
  const [stubSalary] = useState(() => (salaryFromStub(profile, payStub) ? draft.salary : null));
  const salaryHint =
    payStub && stubSalary !== null && draft.salary === stubSalary
      ? `From your pay stub of ${formatDate(payStub.pay_date)}, as a year of paychecks like it. Change it if that paycheck had overtime or a bonus.`
      : null;
  const update = useUpdateProfile();

  const change = (next: Partial<PlanDetailsDraft>) => setDraft((d) => ({ ...d, ...next }));
  const changeTier = (index: number, next: Partial<TierDraft>) =>
    change({ tiers: draft.tiers.map((tier, i) => (i === index ? { ...tier, ...next } : tier)) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const read = readPlanDetails(draft, payStub?.tax_year);
    if (!read.ok) {
      setErrors(read.errors);
      return;
    }
    setErrors({});
    update.mutate({ ...profileInput(profile), ...read.values }, { onSuccess: onSaved });
  };

  const fieldId = (name: string) => `${id}-${name}`;
  const several = draft.tiers.length > 1;
  const tierLabel = (index: number, text: string) =>
    several ? `Tier ${index + 1}: ${text}` : text;

  return (
    <form
      aria-label="Your plan details"
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-4"
    >
      <p className="m-0 text-small text-ink-3">
        The calculator needs your salary, filing status, how your employer matches and the year you
        were born. Your offer letter or benefits summary says how the match works.
      </p>

      <div>
        <Label htmlFor={fieldId('salary')}>Yearly salary</Label>
        <Input
          id={fieldId('salary')}
          inputMode="decimal"
          autoComplete="off"
          placeholder={examplePlaceholder(SALARY_EXAMPLE)}
          value={draft.salary}
          invalid={Boolean(errors.salary)}
          aria-describedby={
            errors.salary
              ? fieldId('salary-error')
              : salaryHint
                ? fieldId('salary-hint')
                : undefined
          }
          onChange={(event) => change({ salary: event.currentTarget.value })}
          className="tabular-nums"
        />
        {salaryHint && !errors.salary && (
          <p id={fieldId('salary-hint')} className="mt-1.5 mb-0 text-tiny text-ink-3">
            {salaryHint}
          </p>
        )}
        <FieldError id={fieldId('salary-error')}>{errors.salary}</FieldError>
      </div>

      <div>
        <div className="mb-1.5 text-small font-semibold text-ink-2">Filing status</div>
        <Seg
          label="Filing status"
          options={FILING_STATUSES}
          value={draft.filingStatus}
          onChange={(filingStatus) => change({ filingStatus })}
        />
        <FieldError id={fieldId('filing-error')}>{errors.filingStatus}</FieldError>
      </div>

      {askFrequency && (
        <div>
          <Label htmlFor={fieldId('frequency')}>How often you are paid</Label>
          <Select
            id={fieldId('frequency')}
            value={draft.payFrequency ?? ''}
            invalid={Boolean(errors.payFrequency)}
            aria-describedby={errors.payFrequency ? fieldId('frequency-error') : undefined}
            onChange={(event) =>
              change({ payFrequency: (event.currentTarget.value || null) as PayFrequency | null })
            }
          >
            <option value="">Choose one</option>
            {PAY_FREQUENCIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <FieldError id={fieldId('frequency-error')}>{errors.payFrequency}</FieldError>
        </div>
      )}

      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-1.5 p-0 text-small font-semibold text-ink-2">Employer match</legend>
        <p id={fieldId('tiers-hint')} className="m-0 text-tiny text-ink-3">
          Tiers count up from 0% of pay. For 100% of the first 3% and 50% of the next 2%, enter 100
          up to 3, then 50 up to 5.
        </p>
        {draft.tiers.map((tier, index) => (
          <div key={index} className="flex flex-wrap items-end gap-3">
            <div className="min-w-36 flex-1">
              <Label htmlFor={fieldId(`employer-${index}`)}>
                {tierLabel(index, 'Employer adds, % of what you put in')}
              </Label>
              <Input
                id={fieldId(`employer-${index}`)}
                inputMode="decimal"
                autoComplete="off"
                value={tier.employerPct}
                invalid={Boolean(errors.tiers)}
                aria-describedby={fieldId(errors.tiers ? 'tiers-error' : 'tiers-hint')}
                onChange={(event) => changeTier(index, { employerPct: event.currentTarget.value })}
                className="tabular-nums"
              />
            </div>
            <div className="min-w-36 flex-1">
              <Label htmlFor={fieldId(`upto-${index}`)}>
                {tierLabel(index, 'Up to, % of your pay')}
              </Label>
              <Input
                id={fieldId(`upto-${index}`)}
                inputMode="decimal"
                autoComplete="off"
                value={tier.uptoPct}
                invalid={Boolean(errors.tiers)}
                aria-describedby={fieldId(errors.tiers ? 'tiers-error' : 'tiers-hint')}
                onChange={(event) => changeTier(index, { uptoPct: event.currentTarget.value })}
                className="tabular-nums"
              />
            </div>
            {several && (
              <Button
                size="sm"
                onClick={() => change({ tiers: draft.tiers.filter((_, i) => i !== index) })}
                aria-label={`Remove tier ${index + 1}`}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        <FieldError id={fieldId('tiers-error')}>{errors.tiers}</FieldError>
        {draft.tiers.length < MAX_TIERS && (
          <div>
            <Button
              size="sm"
              onClick={() => change({ tiers: [...draft.tiers, { employerPct: '', uptoPct: '' }] })}
            >
              Add a tier
            </Button>
          </div>
        )}
      </fieldset>

      <div>
        <Label htmlFor={fieldId('birth-year')}>Year you were born</Label>
        <Input
          id={fieldId('birth-year')}
          inputMode="numeric"
          autoComplete="bday-year"
          placeholder={examplePlaceholder(BIRTH_YEAR_EXAMPLE)}
          maxLength={4}
          value={draft.birthYear}
          invalid={Boolean(errors.birthYear)}
          aria-describedby={fieldId(errors.birthYear ? 'birth-year-error' : 'birth-year-hint')}
          onChange={(event) => change({ birthYear: event.currentTarget.value })}
          className="w-44 tabular-nums"
        />
        <p id={fieldId('birth-year-hint')} className="mt-1.5 mb-0 text-tiny text-ink-3">
          Only used for the extra amount the IRS allows at 50 and over.
        </p>
        <FieldError id={fieldId('birth-year-error')}>{errors.birthYear}</FieldError>
      </div>

      {update.isError && (
        <Notice tone="warning" compact role="alert">
          {apiErrorMessage(update.error, 'Could not save your plan details. Try again.')}
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={update.isPending}>
          Save plan details
        </Button>
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
