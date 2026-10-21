import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Label } from './Label';

export interface RangeProps {
  id: string;
  label: ReactNode;
  /** The current value as words, shown at the end of the label row and spoken. */
  valueLabel: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
}

/** From the mockup's `.range` under a two-sided `.label` row. */
export function Range({
  id,
  label,
  valueLabel,
  min,
  max,
  step = 1,
  value,
  onChange,
  disabled,
  className,
}: RangeProps) {
  return (
    <div className={className}>
      <Label htmlFor={id} aside={valueLabel}>
        {label}
      </Label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={valueLabel}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        className={cn('m-0 block h-11 w-full accent-blue disabled:cursor-not-allowed')}
      />
    </div>
  );
}
