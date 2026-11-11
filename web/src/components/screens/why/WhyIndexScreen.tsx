'use client';

import Link from 'next/link';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconTile } from '@/components/ui/IconTile';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorCode, apiErrorMessage } from '@/lib/api/errors';
import { useDecisions, useExplanation } from '@/lib/api/hooks';
import { formatDate } from '@/lib/dates';
import { calculatorIdOf, CALCULATOR_LABELS } from '@/lib/decisions';
import type { Tone } from '@/lib/design/tone';
import { explanationState, isExplained, type ExplanationState } from '@/lib/explanations';
import { firstDecisionRoute, whyRoute } from '@/lib/routes';
import { CALCULATOR_CARDS } from '../decisions/DecisionCard';

/** Each explanation state in words (spec 008 rule 19c): stale is a note, not an alarm. */
const STATE_BADGES: Record<ExplanationState, { text: string; tone: Tone }> = {
  current: { text: 'Explanation up to date', tone: 'confirmed' },
  stale: { text: 'Explanation out of date', tone: 'blue' },
  fallback: { text: 'Explanation could not be written', tone: 'warning' },
  none: { text: 'Explanation not written yet', tone: 'neutral' },
};

/** The state of a decision's latest explanation; nothing until it is known. */
function ExplanationStateBadge({ decisionId }: { decisionId: string }) {
  const explanation = useExplanation(decisionId);
  const missing = apiErrorCode(explanation.error) === 'not_found';
  if (!explanation.data && !missing) return null;
  const { text, tone } = STATE_BADGES[explanationState(explanation.data ?? null)];
  return (
    <Badge tone={tone} className="ml-auto">
      {text}
    </Badge>
  );
}

/**
 * `/why`: every current decision, each linking to its page and saying what
 * state its explanation is in (spec 008 rule 19c, issue 227), or for an
 * emergency fund, which is never explained, linking to its saved numbers
 * (spec 011 rule 18).
 */
export function WhyIndexScreen() {
  const decisions = useDecisions();
  const items = decisions.data?.items;

  return (
    <>
      <PageTitle
        title="Why each decision"
        lead="What each saved decision means for your money. An emergency fund has no tax rules to explain, so its page shows the numbers you saved."
      />
      {decisions.isError ? (
        <Notice tone="warning" role="alert">
          {apiErrorMessage(
            decisions.error,
            'We could not load your decisions. Reload the page to try again.',
          )}
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
            <Button href={firstDecisionRoute()} variant="primary">
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
                      Saved {formatDate(current.created_at)}
                      {!isExplained(calculator) && ' · No written explanation'}
                    </div>
                  </div>
                  {isExplained(calculator) && <ExplanationStateBadge decisionId={current.id} />}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
