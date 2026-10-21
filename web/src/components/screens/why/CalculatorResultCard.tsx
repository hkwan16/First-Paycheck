import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { KV, KVList } from '@/components/ui/KV';
import { Money } from '@/components/ui/Money';
import type { Decision } from '@/lib/api/types';
import { asK401Inputs, asK401Result, CALCULATOR_LABELS } from '@/lib/decisions';
import { formatRate } from '@/lib/money';
import { tiersText } from '../decisions/decision-format';
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
 * the calculator returned them. Nothing in it came from a language model.
 */
export function CalculatorResultCard({
  decision,
  employer,
  fallbackText,
  actions,
}: CalculatorResultCardProps) {
  const title = `${CALCULATOR_LABELS[decision.calculator]} calculator result`;
  const inputs = decision.calculator === 'k401_match' ? asK401Inputs(decision.inputs) : null;
  const result = decision.calculator === 'k401_match' ? asK401Result(decision.result) : null;

  return (
    <Card inset aria-labelledby="calculator-result-title" gap={14}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="calculator-result-title" className="m-0">
          {title}
        </h2>
        <Badge>Fallback</Badge>
      </div>
      {inputs && result ? (
        <>
          <KVList spacing="comfortable">
            <KV
              label="Inputs"
              value={
                <span>
                  Salary <Money cents={inputs.salary_cents} decimals={0} /> · match{' '}
                  {tiersText(inputs.match_tiers)} · contribution{' '}
                  {formatRate(inputs.contribution_pct)}
                </span>
              }
            />
            <K401ResultRows result={result} employer={employer} />
          </KVList>
          <K401Notices result={result} taxYear={inputs.tax_year} />
        </>
      ) : (
        fallbackText && <p className="m-0">{fallbackText}</p>
      )}
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </Card>
  );
}
