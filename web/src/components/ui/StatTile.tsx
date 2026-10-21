import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { toneSoft, toneText, type Tone } from '@/lib/design/tone';

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  /** md: the Spending summary tile. sm: the compact stat on the plan paper. */
  size?: 'md' | 'sm';
  className?: string;
}

const SURFACE: Record<Tone, string> = { ...toneSoft, neutral: 'bg-tile text-ink' };
const LABEL: Record<Tone, string> = { ...toneText, neutral: 'text-ink-3' };

/** From the mockup's `.tile` (with `.k` and `.v`) and the plan's `.stat`. */
export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
  size = 'md',
  className,
}: StatTileProps) {
  const md = size === 'md';
  return (
    <div
      className={cn(
        SURFACE[tone],
        md ? 'rounded-tile px-4 py-3.5' : 'rounded-seg px-3 py-2.5',
        className,
      )}
    >
      <div
        className={cn('text-tiny', md && 'font-semibold tracking-[0.02em] uppercase', LABEL[tone])}
      >
        {label}
      </div>
      <div className={cn('font-bold tabular-nums', md && 'mt-1 text-stat', toneText[tone])}>
        {value}
      </div>
      {sub !== undefined && <div className="text-tiny text-ink-3">{sub}</div>}
    </div>
  );
}
