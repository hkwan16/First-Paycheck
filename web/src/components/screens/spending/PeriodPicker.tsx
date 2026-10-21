'use client';

import { useId } from 'react';
import { Select } from '@/components/ui/Select';
import type { Period } from '@/lib/api/hooks';
import { periodOptions, selectedPeriodKey, useToday, type PeriodOption } from '@/lib/periods';
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
 * complete month (the API's default) or one of the four before it. The
 * months come from today's date, which is only known on the client, so the
 * server renders just the month the API answered for.
 */
export function PeriodPicker({ value, shown, onChange }: PeriodPickerProps) {
  const id = useId();
  const today = useToday();
  const options: PeriodOption[] = today ? periodOptions(today) : [];
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
