/**
 * Display formatting for money and percentages.
 *
 * Money arrives from the API as integer cents and is only ever formatted
 * here, never added, split or compared: all money math lives in api/calc.
 * Formatting uses integer arithmetic on the cents so no float rounding can
 * change a displayed digit.
 */

export interface FormatMoneyOptions {
  /** 2 shows cents; 0 rounds to whole dollars, half away from zero (like the API). */
  decimals?: 0 | 2;
  /** Prefix positive amounts with "+" (zero is never signed). */
  signed?: boolean;
}

const wholeNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`Money must be integer cents, got ${cents}`);
  }
}

/** `199604` to `"$1,996.04"`; `-1230` to `"-$12.30"`. */
export function formatMoney(cents: number, options: FormatMoneyOptions = {}): string {
  const { decimals = 2, signed = false } = options;
  assertCents(cents);

  const abs = Math.abs(cents);
  const rest = abs % 100;
  let dollars = (abs - rest) / 100;
  let fraction = '';
  if (decimals === 2) {
    fraction = `.${String(rest).padStart(2, '0')}`;
  } else if (rest >= 50) {
    dollars += 1;
  }

  const isZero = decimals === 2 ? abs === 0 : dollars === 0;
  const sign = isZero ? '' : cents < 0 ? '-' : signed ? '+' : '';
  return `${sign}$${wholeNumber.format(dollars)}${fraction}`;
}

export interface NetCost {
  /** The amount with no sign: `"$403"`. */
  amount: string;
  /** True when the API's net cost is negative: the person comes out that much ahead. */
  ahead: boolean;
}

/**
 * A yearly net cost the API computed (spec 012 rule 17), split into its
 * unsigned amount and whether it is ahead. The sign is the API's; this reads
 * it from `formatMoney`'s own text, so an amount that rounds to `$0` is never
 * ahead.
 */
export function netCost(cents: number, options: { decimals?: 0 | 2 } = {}): NetCost {
  const text = formatMoney(cents, options);
  return text.startsWith('-')
    ? { amount: text.slice(1), ahead: true }
    : { amount: text, ahead: false };
}

/** A yearly net cost as a person reads it: `"$2,025.00"`, or `"$403.00 ahead"` when negative. */
export function formatNetCost(cents: number, options: { decimals?: 0 | 2 } = {}): string {
  const { amount, ahead } = netCost(cents, options);
  return ahead ? `${amount} ahead` : amount;
}

export type TransactionFlow = 'in' | 'out' | 'none';

/**
 * Which way a transaction moved money. The API keeps Plaid's sign convention:
 * a positive amount is money out of the account, a negative one money in.
 */
export function transactionFlow(cents: number): TransactionFlow {
  assertCents(cents);
  return cents > 0 ? 'out' : cents < 0 ? 'in' : 'none';
}

/** A transaction as a person reads it: money out `"-$84.12"`, money in `"+$1,996.04"`. */
export function formatTransactionAmount(cents: number): string {
  const flow = transactionFlow(cents);
  const text = formatMoney(Math.abs(cents));
  return flow === 'out' ? `-${text}` : flow === 'in' ? `+${text}` : text;
}

const MONEY_INPUT = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d{1,2}))?$/;

/**
 * Parse what a person typed ("$1,234.56", "12.5", "-12") into integer cents.
 * Returns null for anything that is not a plain amount with at most two
 * decimals, so a form can show "?" instead of guessing.
 */
export function parseMoney(text: string): number | null {
  const match = MONEY_INPUT.exec(text.trim());
  if (!match) return null;
  const [, minus, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return null;

  const dollars = Number(whole.replaceAll(',', '') || '0');
  const cents = dollars * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return minus && cents !== 0 ? -cents : cents;
}

export interface FormatPctOptions {
  decimals?: number;
}

/**
 * Format percentage points as sent by the API (`4` or `"4.00"` means 4%).
 * The API sends Decimal percentages as strings; this only rounds for display.
 */
export function formatPct(points: number | string, options: FormatPctOptions = {}): string {
  const { decimals = 0 } = options;
  const value = typeof points === 'string' ? Number(points.trim() || Number.NaN) : points;
  if (!Number.isFinite(value)) {
    throw new RangeError(`Not a percentage: ${String(points)}`);
  }
  return `${formatNumber(value, { decimals })}%`;
}

const rate = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * A rate the API sends as a two-place Decimal string (`"4.50"`), with the
 * digits it carries and no padding: `"4.5%"`, `"4%"`, `"12.25%"`. The API
 * never sends more than two places, so nothing is rounded.
 */
export function formatRate(points: number | string): string {
  const value = typeof points === 'string' ? Number(points.trim() || Number.NaN) : points;
  if (!Number.isFinite(value)) {
    throw new RangeError(`Not a percentage: ${String(points)}`);
  }
  return `${rate.format(value)}%`;
}

export interface FormatNumberOptions {
  decimals?: number;
  signed?: boolean;
}

/** A plain count or quantity with grouping: `1234` to `"1,234"`. */
export function formatNumber(value: number, options: FormatNumberOptions = {}): string {
  const { decimals = 0, signed = false } = options;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    roundingMode: 'halfExpand',
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(value);
}
