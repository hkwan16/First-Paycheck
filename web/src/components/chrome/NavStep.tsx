import type { ReactNode } from 'react';
import { CheckIcon } from '@/components/icons';
import { cn } from '@/lib/cn';
import { toneSoft } from '@/lib/design/tone';

export interface NavStepProps {
  /** A step number or a 12px glyph. */
  children: ReactNode;
  done?: boolean;
}

/** From the mockup's `.nav-step` and `.nav-step.done`. Decorative; the link text says it. */
export function NavStep({ children, done = false }: NavStepProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-[22px] flex-none items-center justify-center rounded-full text-micro font-semibold tracking-normal',
        done ? toneSoft.confirmed : 'bg-ink/7 text-ink-2',
      )}
    >
      {done ? <CheckIcon size={12} /> : children}
    </span>
  );
}
