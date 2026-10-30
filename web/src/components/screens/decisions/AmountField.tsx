import type { ReactNode, Ref } from 'react';
import { FieldError } from '@/components/ui/FieldError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

export interface AmountFieldProps {
  id: string;
  label: ReactNode;
  /** What is typed, as typed. */
  value: string;
  onChange: (text: string) => void;
  /** What to fix (from `readAmount`); replaces the hint as the description. */
  error: string | null;
  /** Where the starting value came from, or what the amount is for. */
  hint?: ReactNode;
  placeholder?: string;
  className?: string;
  /** The input, for an action that fills the field and moves focus to it. */
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * A dollar amount on a decision card: a text input read with `readAmount`
 * (never a number input, which would drop the commas people type), described
 * by its hint, or by what to fix when it does not read.
 */
export function AmountField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  className,
  inputRef,
}: AmountFieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        ref={inputRef}
        id={id}
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        invalid={Boolean(error)}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="tabular-nums"
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 mb-0 text-tiny text-ink-3">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}
