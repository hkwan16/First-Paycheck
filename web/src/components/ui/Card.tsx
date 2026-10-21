import { createElement, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';

type CardElement = 'section' | 'article' | 'aside' | 'div' | 'form';

const PADDING = { 20: 'p-5', 24: 'p-6' } as const;
const GAP = { 0: 'gap-0', 12: 'gap-3', 14: 'gap-3.5', 16: 'gap-4', 24: 'gap-6' } as const;
const TINT = { confirmed: 'bg-green-tint', warning: 'bg-amber-tint' } as const;

export type CardProps<E extends CardElement = 'section'> = {
  as?: E;
  padding?: keyof typeof PADDING;
  gap?: keyof typeof GAP;
  /** Tints the whole card for a verified (confirmed) or fallback (warning) state. */
  tint?: keyof typeof TINT;
  /** A recessed card on the well color with a border, for fallback content. */
  inset?: boolean;
} & Omit<ComponentPropsWithoutRef<E>, 'as'>;

/** From the mockup's `.card`: the white surface every screen section sits on. */
export function Card<E extends CardElement = 'section'>({
  as,
  padding = 20,
  gap = 16,
  tint,
  inset = false,
  className,
  ...rest
}: CardProps<E>) {
  return createElement(as ?? 'section', {
    ...rest,
    className: cn(
      'flex min-w-0 flex-col rounded-card bg-surface shadow-card',
      PADDING[padding],
      GAP[gap],
      tint && TINT[tint],
      inset && 'border border-ink/14 bg-well',
      className,
    ),
  });
}
