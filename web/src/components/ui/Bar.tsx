import { cn } from '@/lib/cn';
import { toneFill, type Tone } from '@/lib/design/tone';

export interface BarProps {
  /** Percent complete; clamped to 0-100. Computed by the API, never here. */
  value: number;
  /** Required: a bar's color always means something. */
  tone: Tone;
  /** Accessible name, e.g. "Fields confirmed". */
  label: string;
  /** Spoken value when the percent alone is not enough, e.g. "25% of plan". */
  valueText?: string;
  /**
   * Work has started but reports no percent yet: a segment slides along the
   * track (a slow pulse under reduced motion) and `aria-valuenow` is omitted.
   */
  indeterminate?: boolean;
  height?: 8 | 6;
  className?: string;
}

const clamp = (value: number) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

/** From the mockup's `.bar` and `.track`. */
export function Bar({
  value,
  tone,
  label,
  valueText,
  indeterminate = false,
  height = 8,
  className,
}: BarProps) {
  const pct = clamp(value);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : pct}
      aria-valuetext={valueText}
      className={cn(
        'overflow-hidden rounded-full bg-line',
        height === 8 ? 'h-2' : 'h-1.5',
        className,
      )}
    >
      {indeterminate ? (
        <div
          className={cn(
            'h-full w-2/5 animate-indeterminate rounded-full motion-reduce:animate-pulse',
            toneFill[tone],
          )}
        />
      ) : (
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-(--duration-bar) ease-out',
            toneFill[tone],
          )}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}
