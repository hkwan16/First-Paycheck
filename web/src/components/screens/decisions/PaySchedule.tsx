'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { FieldError } from '@/components/ui/FieldError';
import { Label } from '@/components/ui/Label';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { apiErrorMessage } from '@/lib/api/errors';
import { useUpdateProfile } from '@/lib/api/hooks';
import type { PayFrequency, PaySchedule, Profile } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import {
  FREQUENCIES,
  FREQUENCY_WORDS,
  profileInput,
  SCHEDULE_ERROR,
  scheduleText,
} from './plan-details';

/*
 * The pay schedule every card uses (spec 005 rule 25a): the API resolves it,
 * the newest pay stub's before the profile's, and reports it with the
 * profile. These show it, and ask for it where nothing states it.
 */

export interface PayScheduleSelectProps {
  id: string;
  label: string;
  value: PayFrequency | null;
  error?: string;
  onChange: (frequency: PayFrequency | null) => void;
}

/** The four schedules as a labeled native select, empty until one is chosen. */
export function PayScheduleSelect({ id, label, value, error, onChange }: PayScheduleSelectProps) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        value={value ?? ''}
        invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) =>
          onChange(FREQUENCIES.find((frequency) => frequency === event.currentTarget.value) ?? null)
        }
        className="w-56"
      >
        <option value="">Choose one</option>
        {FREQUENCIES.map((frequency) => (
          <option key={frequency} value={frequency}>
            {FREQUENCY_WORDS[frequency]}
          </option>
        ))}
      </Select>
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

/**
 * The schedule a confirmed pay stub states: shown, not asked, since the stub
 * is what payroll pays on. A newer stub is how it changes.
 */
export function StubSchedule({ schedule }: { schedule: PaySchedule }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <div id={id} className="mb-1.5 text-small font-semibold text-ink-2">
        How often you are paid
      </div>
      <p className="m-0 text-small">{scheduleText(schedule)}</p>
      <p className="mt-1.5 mb-0 text-tiny text-ink-3">
        {schedule.pay_stub_date && `From your pay stub of ${formatDate(schedule.pay_stub_date)}. `}
        If your pay schedule changes, <Link href="/setup/link">add a newer pay stub</Link>.
      </p>
    </div>
  );
}

/**
 * For a card that needs only the pay schedule (the emergency fund) when
 * nothing states one: no pay stub that prints it and no entry in the
 * profile. The answer is saved to the profile with `PUT /profile`.
 */
export function PayScheduleForm({ profile }: { profile: Profile }) {
  const id = useId();
  const [frequency, setFrequency] = useState<PayFrequency | null>(profile.pay_frequency ?? null);
  const [error, setError] = useState<string | undefined>(undefined);
  const update = useUpdateProfile();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (frequency === null) {
      setError(SCHEDULE_ERROR);
      return;
    }
    setError(undefined);
    update.mutate({ ...profileInput(profile), pay_frequency: frequency });
  };

  return (
    <form
      aria-label="Your pay schedule"
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-4"
    >
      <p className="m-0 text-small text-ink-3">
        Your monthly transfer is split across your paychecks. Choose how often you are paid, or{' '}
        <Link href="/setup/confirm">confirm a pay stub</Link>, which shows it.
      </p>
      <PayScheduleSelect
        id={`${id}-frequency`}
        label="How often are you paid?"
        value={frequency}
        error={error}
        onChange={(next) => {
          setFrequency(next);
          setError(undefined);
        }}
      />
      {update.isError && (
        <Notice tone="warning" compact role="alert">
          {apiErrorMessage(update.error, 'Could not save your pay schedule. Try again.')}
        </Notice>
      )}
      <div>
        <Button type="submit" variant="primary" loading={update.isPending}>
          Save pay schedule
        </Button>
      </div>
    </form>
  );
}
