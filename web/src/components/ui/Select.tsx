import type { ComponentPropsWithRef } from 'react';
import { cn } from '@/lib/cn';
import { fieldClasses } from './field';

export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'size'> {
  size?: 'md' | 'sm';
  invalid?: boolean;
}

/** A native select in the field style: the platform picker is the accessible one. */
export function Select({ size, invalid, className, ...rest }: SelectProps) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={cn(fieldClasses({ size }), className)}
      {...rest}
    />
  );
}
