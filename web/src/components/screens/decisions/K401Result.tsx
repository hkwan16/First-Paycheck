import { KV } from '@/components/ui/KV';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import type { K401MatchResult } from '@/lib/api/types';
import { formatRate } from '@/lib/money';

/*
 * The 401(k) match calculator's result as label and value rows, shared by
 * the Decisions card and the Why screen's fallback. Every value is the API's,
 * formatted only.
 */

export interface K401ResultRowsProps {
  result: K401MatchResult;
  /** Who matches: the pay stub's employer name, or "Your employer". */
  employer: string;
}

/** Rows for a `KVList`. */
export function K401ResultRows({ result, employer }: K401ResultRowsProps) {
  return (
    <>
      <KV
        label="Contribution for the full match"
        value={`${formatRate(result.full_match_pct)} of salary`}
      />
      <KV
        label="You put in per year"
        value={<Money cents={result.employee_annual_cents_current} decimals={0} />}
      />
      <KV
        label={`${employer} adds per year`}
        value={
          <Money
            cents={result.employer_match_cents_current}
            decimals={0}
            tone="plum"
            className="font-semibold"
          />
        }
      />
      <KV
        label={`${employer} adds at the full match`}
        value={<Money cents={result.employer_match_cents_full} decimals={0} />}
      />
      <KV
        label="Match you miss per year"
        value={<Money cents={result.missed_cents} decimals={0} />}
      />
      <KV
        label="Extra per paycheck for the full match, before tax"
        value={<Money cents={result.per_paycheck_cost_delta_cents} />}
      />
      <KV
        label={`Extra per paycheck, after federal tax at ${formatRate(result.marginal_rate_used)} marginal`}
        value={<Money cents={result.per_paycheck_after_tax_cost_cents} />}
      />
    </>
  );
}

export interface K401NoticesProps {
  result: K401MatchResult;
  taxYear: number;
}

/** The limits that bind, when the result says they do (spec 006 rules 3a and 4). */
export function K401Notices({ result, taxYear }: K401NoticesProps) {
  if (!result.capped && !result.compensation_capped) return null;
  return (
    <div className="flex flex-col gap-2">
      {result.capped && (
        <Notice tone="warning" compact title={`Over the ${taxYear} limit.`}>
          This contribution would put in more than the{' '}
          <Money cents={result.deferral_limit_cents} decimals={0} /> the IRS allows for {taxYear},
          so the calculator stops your contributions at the limit. A plan that matches each paycheck
          may stop matching once you reach it.
        </Notice>
      )}
      {result.compensation_capped && (
        <Notice tone="blue" compact icon={null}>
          Your salary is above the {taxYear} compensation limit, so the match is figured on pay up
          to that limit.
        </Notice>
      )}
    </div>
  );
}
