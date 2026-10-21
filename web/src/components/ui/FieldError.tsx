import type { ReactNode } from 'react';

export interface FieldErrorProps {
  /** Referenced by the field's `aria-describedby`. */
  id: string;
  /** The message; nothing renders when it is empty. */
  children: ReactNode;
}

/**
 * The inline message under an invalid field, in the same red as the field's
 * `aria-invalid` border (`field.ts`). The mockup has no invalid state, so this
 * follows the input's own treatment.
 */
export function FieldError({ id, children }: FieldErrorProps) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <p id={id} className="mt-1.5 mb-0 text-small text-red-text">
      {children}
    </p>
  );
}
