import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { KV, KVList } from '@/components/ui/KV';
import { Money } from '@/components/ui/Money';
import { StatTile } from '@/components/ui/StatTile';
import type { PlanPayStub } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { payFrequencyLabel } from './plan-format';

type CentsKey = Extract<keyof PlanPayStub, `${string}_cents`>;

/** The deductions in the order a pay stub prints them. */
const LINES: readonly [CentsKey, string][] = [
  ['federal_withholding_cents', 'Federal withholding'],
  ['social_security_cents', 'Social Security'],
  ['medicare_cents', 'Medicare'],
  ['state_tax_cents', 'State tax'],
  ['retirement_contribution_cents', '401(k)'],
  ['medical_premium_cents', 'Medical premium'],
  ['other_deductions_cents', 'Other deductions'],
];

/**
 * "Your paycheck", from the plan paper's stat row: the newest confirmed pay
 * stub the plan is built on (spec 016 rule 7), each amount as confirmed.
 */
export function PaycheckCard({ payStub }: { payStub: PlanPayStub | null }) {
  return (
    <Card aria-labelledby="paycheck-title" gap={14}>
      <div>
        <h2 id="paycheck-title" className="m-0">
          Your paycheck
        </h2>
        {payStub && (
          <p className="m-0 text-small text-ink-3">
            {[
              payStub.employer_name,
              `paid ${formatDate(payStub.pay_date)}`,
              payFrequencyLabel(payStub.pay_frequency),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </div>
      {payStub ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatTile
              size="sm"
              tone="plum"
              label="Gross pay"
              value={<Money cents={payStub.gross_cents} />}
            />
            <StatTile
              size="sm"
              tone="coral"
              label="Take-home pay"
              value={<Money cents={payStub.net_cents} />}
            />
          </div>
          <KVList>
            {LINES.map(([key, label]) => (
              <KV key={key} label={label} value={<Money cents={payStub[key]} />} />
            ))}
          </KVList>
        </>
      ) : (
        <p className="m-0 text-small text-ink-3">
          No confirmed pay stub yet. <Link href="/setup/confirm">Confirm your pay stub</Link> to see
          it here.
        </p>
      )}
    </Card>
  );
}
