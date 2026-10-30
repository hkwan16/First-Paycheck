import type { ReactNode } from 'react';
import { CheckIcon } from '@/components/icons';
import { cn } from '@/lib/cn';
import { toneSoft } from '@/lib/design/tone';

export interface NavStepProps {
  /** A step number or a 12px glyph. */
  children: ReactNode;
  done?: boolean;
  /** `sm` marks a sub-step (a decision under Decisions): 18px instead of 22px. */
  size?: 'md' | 'sm';
}

/** From the mockup's `.nav-step` and `.nav-step.done`. Decorative; the link text says it. */
export function NavStep({ children, done = false, size = 'md' }: NavStepProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex flex-none items-center justify-center rounded-full text-micro font-semibold tracking-normal',
        size === 'sm' ? 'size-[18px]' : 'size-[22px]',
        done ? toneSoft.confirmed : 'bg-ink/7 text-ink-2',
      )}
    >
      {done ? <CheckIcon size={size === 'sm' ? 10 : 12} /> : children}
    </span>
  );
}
