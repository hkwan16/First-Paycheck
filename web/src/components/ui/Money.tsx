import { cn } from '@/lib/cn';
import { toneText, type Tone } from '@/lib/design/tone';
import { formatMoney, formatNumber, formatPct } from '@/lib/money';

export interface MoneyProps {
  /** Integer cents exactly as the API returned them. */
  cents: number;
  decimals?: 0 | 2;
  signed?: boolean;
  tone?: Tone;
  className?: string;
}

/** A dollar amount from the API, in tabular numerals. Formats only; never computes. */
export function Money({ cents, decimals = 2, signed = false, tone, className }: MoneyProps) {
  return (
    <span className={cn('tabular-nums', tone && toneText[tone], className)}>
      {formatMoney(cents, { decimals, signed })}
    </span>
  );
}

export interface NumProps {
  value: number;
  decimals?: number;
  /** Treat value as percentage points: 12 renders "12%". */
  percent?: boolean;
  signed?: boolean;
  tone?: Tone;
  className?: string;
}

/** A count, quantity or percentage from the API, in tabular numerals. */
export function Num({
  value,
  decimals = 0,
  percent = false,
  signed = false,
  tone,
  className,
}: NumProps) {
  const text = percent ? formatPct(value, { decimals }) : formatNumber(value, { decimals, signed });
  return <span className={cn('tabular-nums', tone && toneText[tone], className)}>{text}</span>;
}
