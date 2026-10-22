'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
}

export interface SegProps<T extends string> {
  /** Accessible name of the group, e.g. "Filing status". */
  label: string;
  options: readonly SegOption<T>[];
  /** The chosen option; null before one is chosen (none pressed, the first is the tab stop). */
  value: T | null;
  onChange: (value: T) => void;
  className?: string;
}

const KEY_STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * From the mockup's `.seg`: a segmented control built as a group of toggle
 * buttons. One tab stop (the pressed option); arrow keys move and select,
 * wrapping at the ends; Home and End jump.
 */
export function Seg<T extends string>({ label, options, value, onChange, className }: SegProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const select = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    buttons.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = options.length;
    let next: number | undefined;
    if (event.key in KEY_STEP) next = (index + (KEY_STEP[event.key] ?? 0) + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  };

  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex flex-wrap gap-0.5 rounded-control bg-fill p-[3px]', className)}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type="button"
          aria-pressed={option.value === value}
          tabIndex={index === selected ? 0 : -1}
          onClick={() => select(index)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className={cn(
            'min-h-[38px] rounded-seg border-0 bg-transparent px-3.5 text-small leading-[1.5] font-medium text-ink-2',
            'transition-[scale] duration-(--duration-press) ease-out active:scale-[.97] motion-reduce:active:scale-100',
            'aria-pressed:bg-surface aria-pressed:font-semibold aria-pressed:text-ink aria-pressed:shadow-thumb',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
