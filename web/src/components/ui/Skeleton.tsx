import { cn } from '@/lib/cn';

export interface SkeletonProps {
  /** A block-level placeholder (a row, a control) instead of one on the text line. */
  block?: boolean;
  /** Width and height, e.g. "w-24" or "h-9 w-full". */
  className?: string;
}

/**
 * A placeholder where a value from the API will appear. Decorative: the
 * region it sits in carries `aria-busy` and the loading wording. It pulses,
 * and holds still under reduced motion.
 */
export function Skeleton({ block = false, className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      data-skeleton=""
      className={cn(
        'animate-pulse rounded-seg bg-fill-strong motion-reduce:animate-none',
        block ? 'block' : 'inline-block h-[1em] w-20 align-[-0.125em]',
        className,
      )}
    />
  );
}
