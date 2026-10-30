import type { ComponentProps } from 'react';
import { KV, KVList } from '@/components/ui/KV';
import { Money } from '@/components/ui/Money';
import type { EmergencyFundResult } from '@/lib/api/types';
import { formatRate } from '@/lib/money';
import { monthsText } from './emergency-fund-format';

export interface FundResultRowsProps {
  result: EmergencyFundResult;
  /** The months of essentials the result was calculated for. */
  targetMonths: number;
  /** Paychecks a year, for the per-paycheck label. */
  periods: number;
  spacing?: ComponentProps<typeof KVList>['spacing'];
  rules?: ComponentProps<typeof KVList>['rules'];
}

/** "Already there", "12 months" or "Not within 10 years": the result's words for its reach. */
function reachText(result: EmergencyFundResult): string {
  if (result.funded) return 'Already there';
  if (result.months_to_target === null) {
    return `Not within ${monthsText(result.horizon_months, { years: true })}`;
  }
  return monthsText(result.months_to_target);
}

/**
 * The emergency fund calculator's result as rows (spec 011): the target, the
 * suggested range, what is saved and still to save, the months to reach it
 * and the contribution per paycheck. Every figure is a field of the result.
 */
export function FundResultRows({
  result,
  targetMonths,
  periods,
  spacing,
  rules,
}: FundResultRowsProps) {
  return (
    <KVList spacing={spacing} rules={rules}>
      <KV
        label={`Target, ${monthsText(targetMonths)} of essentials`}
        value={<Money cents={result.target_cents} className="font-semibold" />}
      />
      <KV
        label="Suggested range, 3 to 6 months"
        value={
          <>
            <Money cents={result.three_month_target_cents} /> to{' '}
            <Money cents={result.six_month_target_cents} />
          </>
        }
      />
      <KV label="Already saved" value={`${formatRate(result.funded_pct)} of the target`} />
      <KV label="Still to save" value={<Money cents={result.shortfall_cents} />} />
      <KV label="Months to reach it" value={reachText(result)} />
      <KV
        label={`Per paycheck, ${periods} a year`}
        value={<Money cents={result.per_paycheck_contribution_cents} tone="teal" />}
      />
    </KVList>
  );
}
