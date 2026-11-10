'use client';

import { useId } from 'react';
import { Select } from '@/components/ui/Select';
import { useSpendingMonths, type Period } from '@/lib/api/hooks';
import {
  optionsWithin,
  periodOptions,
  selectedPeriodKey,
  useToday,
  type PeriodOption,
} from '@/lib/periods';
import { periodText } from './spending-format';

export interface PeriodPickerProps {
  /** The period asked for; null is the API's default (the last complete month). */
  value: Period | null;
  /** The period the API answered for, once it has. */
  shown: Period | undefined;
  onChange: (period: Period | null) => void;
}

/**
 * Which month the totals and the diagram cover: this month so far, the last
 * complete month (the API's default) or one of the four before it, each only
 * when it has a transaction or a pay stub to show (`GET /spending/months`,
 * spec 010 rule 5d; all six if that cannot be read). The months come from
 * today's date, which is only known on the client, so the server renders
 * just the month the API answered for.
 */
export function PeriodPicker({ value, shown, onChange }: PeriodPickerProps) {
  const id = useId();
  const today = useToday();
  const months = useSpendingMonths();
  const known = months.isError ? null : months.data?.months;
  const options: PeriodOption[] =
    today && known !== undefined ? optionsWithin(periodOptions(today), known) : [];
  const selected = selectedPeriodKey(value, shown);
  if (shown && !options.some((o) => o.value === selected)) {
    options.unshift({ value: selected, label: periodText(shown.start, shown.end), period: shown });
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-small font-semibold text-ink-2">
        Period
      </label>
      <Select
        id={id}
        size="sm"
        className="w-auto"
        value={selected}
        disabled={options.length === 0}
        onChange={(event) => {
          const option = options.find((o) => o.value === event.currentTarget.value);
          if (option) onChange(option.period);
        }}
      >
        {options.length === 0 && <option value="">Loading</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
