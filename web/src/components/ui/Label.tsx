import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface LabelProps extends ComponentPropsWithoutRef<'label'> {
  /** A value shown at the far end of the label row, e.g. a slider's "4% of salary". */
  aside?: ReactNode;
}

/** From the mockup's `.label`. */
export function Label({ aside, className, children, ...rest }: LabelProps) {
  return (
    <label
      className={cn(
        'mb-1.5 text-small leading-[1.5] font-semibold text-ink-2',
        aside === undefined ? 'block' : 'flex justify-between gap-2',
        className,
      )}
      {...rest}
    >
      {aside === undefined ? (
        children
      ) : (
        <>
          <span>{children}</span>
          <span className="tabular-nums">{aside}</span>
        </>
      )}
    </label>
  );
}
