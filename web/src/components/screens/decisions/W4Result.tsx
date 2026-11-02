import type { ReactNode } from 'react';
import { KV, KVList } from '@/components/ui/KV';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tile } from '@/components/ui/Tile';
import { apiErrorMessage } from '@/lib/api/errors';
import type { CalcState } from '@/lib/api/hooks';
import type { PayStub, W4Input } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { toneText } from '@/lib/design/tone';
import { formatRefund } from '@/lib/money';
import { methodText, refundHeadline, refundTone, WITHHOLDING_TABLES_SOURCE } from './w4-format';

export const W4_CALC_PATH = '/calc/w4';

export interface W4ResultProps {
  inputs: W4Input | null;
  /** What to enter first, while the inputs are incomplete. */
  missing: string | null;
  calc: CalcState<typeof W4_CALC_PATH>;
  /** The newest confirmed stub, which the comparison names. */
  payStub: PayStub;
}

/**
 * The W-4 card's result panel: every figure is a field of the calculator's
 * result or of its inputs. What the stub's withholding leaves at tax time
 * comes first (spec 014 rule 10a), then what this W-4 would.
 */
export function W4Result({ inputs, missing, calc, payStub }: W4ResultProps) {
  const result = calc.data;
  let content: ReactNode;
  if (inputs === null) {
    content = (
      <p className="m-0 text-small text-ink-3">
        {missing ?? 'Fill in the form'} to see your numbers.
      </p>
    );
  } else if (calc.isError) {
    content = (
      <Notice tone="warning" compact role="alert">
        {apiErrorMessage(calc.error, 'Could not work out your numbers. Try again in a moment.')}
      </Notice>
    );
  } else if (result) {
    const tone = refundTone(result.projected_refund_cents);
    // The inputs of the result on screen (the previous one stays while the next loads).
    const shown = calc.inputs ?? inputs;
    const current = result.current_refund_cents;
    const currentWithholding = shown.current_withholding_per_paycheck_cents;
    const atStub =
      current !== null &&
      currentWithholding != null &&
      result.current_annual_withholding_cents !== null ? (
        <div role="group" aria-label="If you change nothing" className="flex flex-col gap-1">
          <div className="text-small font-semibold text-ink-2">If you change nothing</div>
          <div className={cn('text-headline font-bold', toneText[refundTone(current)])}>
            {refundHeadline(current)}
          </div>
          <p className="m-0 text-tiny text-ink-3">
            Your {formatDate(payStub.pay_date, 'short')} pay stub takes out{' '}
            <Money cents={currentWithholding} /> a paycheck, or{' '}
            <Money cents={result.current_annual_withholding_cents} /> over{' '}
            {shown.pay_periods_per_year} paychecks if every paycheck this year is the same. That
            changes only when you give your employer a new Form W-4.
          </p>
        </div>
      ) : null;
    content = (
      <>
        {atStub}
        <div className={cn('flex flex-col gap-1', atStub && 'border-t border-line pt-3')}>
          <div className="text-small font-semibold text-ink-2">
            If you give your employer this W-4
          </div>
          <div className={cn('text-headline font-bold', toneText[tone])} aria-live="polite">
            {refundHeadline(result.projected_refund_cents)}
          </div>
        </div>
        <KVList rules="all" spacing="panel">
          <KV
            label="Taken out of each paycheck"
            value={
              <Money cents={result.withholding_per_paycheck_cents} className="font-semibold" />
            }
          />
          <KV
            label={`Taken out this year, ${shown.pay_periods_per_year} paychecks`}
            value={<Money cents={result.annual_withholding_cents} />}
          />
          {shown.dependents_credit_cents !== 0 && (
            <KV label="Tax before credits" value={<Money cents={result.projected_tax_cents} />} />
          )}
          <KV
            label={`Your ${shown.tax_year} federal income tax`}
            value={<Money cents={result.projected_tax_after_credits_cents} />}
          />
          <KV
            label="Refund or amount due at tax time"
            value={
              <span className={cn('font-semibold', toneText[tone])}>
                {formatRefund(result.projected_refund_cents)}
              </span>
            }
          />
          <KV
            label="Taxed pay in each paycheck"
            value={<Money cents={result.taxable_wages_per_paycheck_cents} />}
          />
        </KVList>
        <p className="m-0 text-tiny text-ink-3">
          {methodText(result)} The tax for the year uses the {shown.tax_year} tax brackets and
          standard deduction. Source:{' '}
          <a href={WITHHOLDING_TABLES_SOURCE} target="_blank" rel="noopener noreferrer">
            IRS Publication 15-T
          </a>
          .
        </p>
        {result.k401_capped && (
          <Notice tone="warning" compact>
            Your 401(k) rate would put in more than this year&apos;s limit, so the estimate counts{' '}
            <Money cents={result.k401_annual_cents} />, the most you can put in.
          </Notice>
        )}
      </>
    );
  } else {
    content = (
      <div className="flex flex-col gap-2.5">
        <Skeleton className="w-3/4" />
        <Skeleton className="w-full" />
        <Skeleton className="w-full" />
        <span className="sr-only">Working out your numbers.</span>
      </div>
    );
  }
  return (
    <Tile
      tone="blue"
      role="group"
      aria-label="Your numbers"
      aria-busy={(inputs !== null && calc.isBusy) || undefined}
    >
      {content}
    </Tile>
  );
}
