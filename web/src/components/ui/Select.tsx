import type { ComponentPropsWithRef } from 'react';
import { cn } from '@/lib/cn';
import { fieldClasses } from './field';

export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'size'> {
  size?: 'md' | 'sm';
  invalid?: boolean;
}

/**
 * A native select in the field style: the platform picker is the accessible one. The closed
 * field draws its own chevron (`select-chevron`, in the text color) because the platform's arrow
 * comes from the OS theme and moves with host settings; forced colors gets the platform's back.
 */
export function Select({ size, invalid, className, ...rest }: SelectProps) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={cn(
        fieldClasses({ size }),
        'appearance-none select-chevron forced-colors:appearance-auto forced-colors:bg-none',
        size === 'sm' ? 'pr-8' : 'pr-9',
        className,
      )}
      {...rest}
    />
  );
}
