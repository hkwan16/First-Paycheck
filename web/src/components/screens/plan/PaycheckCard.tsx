import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { KV, KVList } from '@/components/ui/KV';
import { Money } from '@/components/ui/Money';
import { StatTile } from '@/components/ui/StatTile';
import type { PlanPayStub } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { PAYCHECK_LINES, PAYCHECK_TILES, payFrequencyLabel } from './plan-format';

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
              label={PAYCHECK_TILES.gross}
              value={<Money cents={payStub.gross_cents} />}
            />
            <StatTile
              size="sm"
              tone="coral"
              label={PAYCHECK_TILES.net}
              value={<Money cents={payStub.net_cents} />}
            />
          </div>
          <KVList>
            {PAYCHECK_LINES.map(([key, label]) => (
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
