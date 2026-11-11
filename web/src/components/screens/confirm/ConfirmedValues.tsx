import { useId, type ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { KV, KVList } from '@/components/ui/KV';
import { Money } from '@/components/ui/Money';
import { PLAN_KIND_LABELS } from '@/components/screens/decisions/health-plan-format';
import { payFrequencyLabel } from '@/components/screens/plan/plan-format';
import type { BenefitsPlan, PayStub } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { formatRate } from '@/lib/money';

/** The stub's own amounts; `annual_salary_cents` is worked out from them (spec 005 rule 24a). */
type CentsKey = Exclude<Extract<keyof PayStub, `${string}_cents`>, 'annual_salary_cents'>;

/** The amounts in the order the Confirm review lists them, under its labels. */
const AMOUNTS: readonly [CentsKey, string][] = [
  ['gross_cents', 'Gross pay'],
  ['federal_withholding_cents', 'Federal income tax'],
  ['social_security_cents', 'Social Security'],
  ['medicare_cents', 'Medicare'],
  ['state_tax_cents', 'State income tax'],
  ['retirement_contribution_cents', '401(k) contribution'],
  ['medical_premium_cents', 'Medical premium'],
  ['other_deductions_cents', 'Other deductions'],
  ['net_cents', 'Net pay'],
];

const NOT_SHOWN = 'Not shown on the stub';

function ValuesCard({ children }: { children: ReactNode }) {
  const titleId = useId();
  return (
    <Card aria-labelledby={titleId} gap={12}>
      <div>
        <h2 id={titleId} className="m-0">
          What you confirmed
        </h2>
        <p className="m-0 text-small text-ink-3">
          Confirmed values stay as they are. If one is wrong, replace the document from your
          documents and check the new one.
        </p>
      </div>
      {children}
    </Card>
  );
}

/**
 * A confirmed pay stub's values, read-only (spec 005 rule 22h, issue 243): the
 * file and the proposal are gone once it is confirmed, so this is the one place
 * to see what was stored from it.
 */
export function ConfirmedPayStub({ stub }: { stub: PayStub }) {
  return (
    <ValuesCard>
      <KVList spacing="comfortable">
        <KV label="Employer" value={stub.employer_name ?? NOT_SHOWN} />
        <KV label="Pay date" value={formatDate(stub.pay_date)} />
        <KV
          label="Pay period"
          value={`${formatDate(stub.period_start)} to ${formatDate(stub.period_end)}`}
        />
        <KV label="Pay frequency" value={payFrequencyLabel(stub.pay_frequency) ?? NOT_SHOWN} />
        {AMOUNTS.map(([key, label]) => (
          <KV key={key} label={label} value={<Money cents={stub[key]} />} />
        ))}
      </KVList>
    </ValuesCard>
  );
}

function PlanValues({ plan }: { plan: BenefitsPlan }) {
  const nameId = useId();
  return (
    <div role="group" aria-labelledby={nameId} className="flex flex-col gap-1">
      <h3 id={nameId} className="m-0">
        {plan.name}
      </h3>
      <KVList>
        <KV label="Plan type" value={PLAN_KIND_LABELS[plan.kind]} />
        <KV label="Premium per paycheck" value={<Money cents={plan.premium_per_period_cents} />} />
        <KV label="Deductible" value={<Money cents={plan.deductible_cents} />} />
        <KV label="Out-of-pocket maximum" value={<Money cents={plan.oop_max_cents} />} />
        <KV label="Coinsurance" value={formatRate(plan.coinsurance_pct)} />
        <KV label="Employer HSA contribution" value={<Money cents={plan.employer_hsa_cents} />} />
        <KV
          label="Enrollment deadline"
          value={plan.enrollment_deadline ? formatDate(plan.enrollment_deadline) : 'None given'}
        />
      </KVList>
    </div>
  );
}

/** A confirmed benefits summary's plans, read-only, in the summary's order (rule 22h). */
export function ConfirmedPlans({ plans }: { plans: readonly BenefitsPlan[] }) {
  return (
    <ValuesCard>
      <div className="flex flex-col gap-5">
        {plans.map((plan) => (
          <PlanValues key={plan.id} plan={plan} />
        ))}
      </div>
    </ValuesCard>
  );
}
