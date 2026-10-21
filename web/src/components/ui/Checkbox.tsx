import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  className?: string;
  children: ReactNode;
}

/** From the mockup's `.check`: the whole 44px row is the hit target. */
export function Checkbox({
  checked,
  onChange,
  disabled,
  name,
  className,
  children,
}: CheckboxProps) {
  return (
    <label
      className={cn(
        'flex min-h-11 items-center gap-2.5 text-control font-medium',
        disabled && 'cursor-not-allowed text-ink-3',
        className,
      )}
    >
      <input
        type="checkbox"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="m-0 size-5 flex-none accent-blue"
      />
      {children}
    </label>
  );
}
