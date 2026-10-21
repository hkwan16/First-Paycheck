import type { ComponentPropsWithRef } from 'react';
import { cn } from '@/lib/cn';
import { fieldClasses } from './field';

export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'size'> {
  /** md: 44px forms. sm: 40px rows in dense tables. */
  size?: 'md' | 'sm';
  invalid?: boolean;
}

export function Input({ size, invalid, className, ...rest }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(fieldClasses({ size }), className)}
      {...rest}
    />
  );
}
