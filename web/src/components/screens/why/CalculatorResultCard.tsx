import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { KV, KVList } from '@/components/ui/KV';
import { Money } from '@/components/ui/Money';
import type { Decision } from '@/lib/api/types';
import {
  asEmergencyFundInputs,
  asEmergencyFundResult,
  asK401Inputs,
  asK401Result,
} from '@/lib/decisions';
import { formatRate } from '@/lib/money';
import { tiersText } from '../decisions/decision-format';
import { FundResultRows } from '../decisions/FundResultRows';
import { K401Notices, K401ResultRows } from '../decisions/K401Result';

export interface CalculatorResultCardProps {
  decision: Decision;
  employer: string;
  /** Text to show when the result is not one this screen can lay out (a newer calculator). */
  fallbackText?: string;
  /** Buttons under the result. */
  actions?: ReactNode;
}

/**
 * From the mockup's fallback card: the saved decision's inputs and result as
 * the API stored them, shown in place of an explanation that could not be
 * written, or as the whole answer for a decision that is never explained
 * (spec 011 rule 18).
 */
export function CalculatorResultCard({
  decision,
  employer,
  fallbackText,
  actions,
}: CalculatorResultCardProps) {
  const inputs = decision.calculator === 'k401_match' ? asK401Inputs(decision.inputs) : null;
  const result = decision.calculator === 'k401_match' ? asK401Result(decision.result) : null;
  const fundInputs =
    decision.calculator === 'emergency_fund' ? asEmergencyFundInputs(decision.inputs) : null;
  const fundResult =
    decision.calculator === 'emergency_fund' ? asEmergencyFundResult(decision.result) : null;

  return (
    <Card inset aria-labelledby="saved-numbers-title" gap={14}>
      <h2 id="saved-numbers-title" className="m-0">
        Your saved numbers
      </h2>
      {inputs && result ? (
        <>
          <KVList spacing="comfortable">
            <KV
              label="Based on"
              value={
                <span>
                  Salary <Money cents={inputs.salary_cents} decimals={0} /> · match{' '}
                  {tiersText(inputs.match_tiers)} · your rate {formatRate(inputs.contribution_pct)}
                </span>
              }
            />
            <K401ResultRows result={result} employer={employer} />
          </KVList>
          <K401Notices result={result} taxYear={inputs.tax_year} />
        </>
      ) : fundInputs && fundResult ? (
        <FundResultRows
          result={fundResult}
          targetMonths={fundInputs.target_months}
          periods={fundInputs.pay_periods_per_year}
          spacing="comfortable"
        />
      ) : (
        fallbackText && <p className="m-0">{fallbackText}</p>
      )}
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </Card>
  );
}
