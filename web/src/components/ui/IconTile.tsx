import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { toneSoft, type Tone } from '@/lib/design/tone';

export interface IconTileProps {
  tone?: Tone;
  /** Initials drawn instead of an icon (an institution, for example). */
  label?: string;
  /** Neutral grey, for handled or dismissed items. */
  muted?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * From the mockup's `.ico` and `.sev`: a 36px tinted square holding a glyph.
 * Decorative: the text beside it says what it is.
 */
export function IconTile({
  tone = 'neutral',
  label,
  muted = false,
  className,
  children,
}: IconTileProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-9 flex-none items-center justify-center rounded-control',
        muted ? toneSoft.neutral : toneSoft[tone],
        label !== undefined && 'text-tiny font-bold',
        className,
      )}
    >
      {label ?? children}
    </span>
  );
}
