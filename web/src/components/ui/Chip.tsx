import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface ChipProps {
  className?: string;
  children: ReactNode;
}

/** From the mockup's `.chip`: quiet context in the header (employer, pay schedule, user). */
export function Chip({ className, children }: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full bg-fill px-2.5 py-1 text-tiny leading-[1.5] font-medium whitespace-nowrap text-ink-2',
        className,
      )}
    >
      {children}
    </span>
  );
}
