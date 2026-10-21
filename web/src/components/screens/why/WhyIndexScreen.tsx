'use client';

import Link from 'next/link';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconTile } from '@/components/ui/IconTile';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorMessage } from '@/lib/api/errors';
import { useDecisions } from '@/lib/api/hooks';
import { formatDate } from '@/lib/dates';
import { calculatorIdOf, CALCULATOR_LABELS } from '@/lib/decisions';
import { whyRoute } from '@/lib/routes';
import { CALCULATOR_CARDS } from '../decisions/DecisionCard';

/** `/why`: every current decision, each linking to its explanation. */
export function WhyIndexScreen() {
  const decisions = useDecisions();
  const items = decisions.data?.items;

  return (
    <>
      <PageTitle
        title="Why each decision"
        lead="Each saved decision has a plain-language explanation, checked against the calculator before you see it."
      />
      {decisions.isError ? (
        <Notice tone="warning" role="alert">
          {apiErrorMessage(decisions.error, 'Could not load your decisions. Reload to try again.')}
        </Notice>
      ) : !items ? (
        <Card aria-label="Loading your decisions" aria-busy="true">
          <Skeleton className="w-1/2" />
          <Skeleton className="w-2/3" />
        </Card>
      ) : items.length === 0 ? (
        <Card gap={14} aria-label="Saved decisions">
          <p className="m-0">No decisions saved yet.</p>
          <div>
            <Button href="/setup/decisions" variant="primary">
              Go to decisions
            </Button>
          </div>
        </Card>
      ) : (
        <Card padding={20} gap={0}>
          <ul aria-label="Saved decisions" className="m-0 list-none p-0">
            {items.map(({ calculator, current }) => {
              const { icon, tone } = CALCULATOR_CARDS[calculatorIdOf(calculator)];
              return (
                <li
                  key={calculator}
                  className="flex items-center gap-3 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <IconTile tone={tone}>{icon}</IconTile>
                  <div className="min-w-0">
                    <Link href={whyRoute(current.id)} className="font-semibold">
                      {CALCULATOR_LABELS[calculator]}
                    </Link>
                    <div className="text-small text-ink-3">
                      v{current.version} · Saved {formatDate(current.created_at)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
