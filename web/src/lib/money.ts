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
