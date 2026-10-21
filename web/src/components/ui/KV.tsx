import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Badge } from './Badge';

export interface KVListProps {
  /** compact (6px rows) for result panels; comfortable (8px) for reading screens. */
  spacing?: 'compact' | 'comfortable';
  /** between: no rule above the first row; all: rule it too (when a headline sits above). */
  rules?: 'between' | 'all';
  className?: string;
  children: ReactNode;
}

/** A list of label and value rows, from the mockup's stacked `.kv` rows. */
export function KVList({
  spacing = 'compact',
  rules = 'between',
  className,
  children,
}: KVListProps) {
  return (
    <dl
      className={cn(
        'm-0',
        spacing === 'comfortable' && '[&>div]:py-2 [&>div:first-child]:pt-0',
        rules === 'all' && '[&>div:first-child]:border-t',
        className,
      )}
    >
      {children}
    </dl>
  );
}

export interface KVProps {
  label: ReactNode;
  value: ReactNode;
  /** The verifier found this exact figure in the calculator's output. */
  verified?: boolean;
  className?: string;
}

/** From the mockup's `.kv`: label left, tabular value right, hairline between rows. */
export function KV({ label, value, verified = false, className }: KVProps) {
  return (
    <div
      className={cn(
        'flex justify-between gap-3 border-t border-line py-1.5 text-control first:border-t-0',
        className,
      )}
    >
      <dt>{label}</dt>
      <dd className="m-0 inline-flex items-center gap-1.5 text-right tabular-nums">
        {value}
        {verified && (
          <Badge tone="confirmed" aria-label="matches calculator">
            =
          </Badge>
        )}
      </dd>
    </div>
  );
}
