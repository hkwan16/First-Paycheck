import Link from 'next/link';
import { CheckIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { KV, KVList } from '@/components/ui/KV';
import type { PlanDecision } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { calculatorIdOf, CALCULATOR_LABELS } from '@/lib/decisions';
import { whyRoute } from '@/lib/routes';
import { CALCULATOR_CARDS, DecisionCard } from '../decisions/DecisionCard';
import { explanationView, figureText } from './plan-format';

/** The decision's explanation in a line: checked, out of date, not written, or none yet (spec 008 rule 19b). */
function ExplanationStatus({ decision }: { decision: PlanDecision }) {
  const why = whyRoute(decision.id);
  switch (explanationView(decision)) {
    case 'verified':
      return (
        <div>
          <Badge tone="confirmed" icon={<CheckIcon />} href={why}>
            Read the explanation
          </Badge>
        </div>
      );
    case 'stale':
      return (
        <p className="m-0 text-small text-ink-3">
          Written before some of your information changed.{' '}
          <Link href={why}>Update the explanation</Link>
        </p>
      );
    case 'fallback':
      return (
        <p className="m-0 text-small text-ink-3">
          We could not write this explanation. <Link href={why}>Try again on its page</Link>
        </p>
      );
    case 'none':
      return (
        <p className="m-0 text-small text-ink-3">
          No explanation yet. <Link href={why}>Write the explanation</Link>
        </p>
      );
    case 'unavailable':
      return null;
  }
}

/**
 * One saved decision on the plan: when it was saved, the figures `GET /plan`
 * chose for its calculator (spec 016 rule 3), each by the API's label, and
 * its explanation status.
 */
export function DecisionSummary({ decision }: { decision: PlanDecision }) {
  const { icon, tone } = CALCULATOR_CARDS[calculatorIdOf(decision.calculator)];
  return (
    <DecisionCard
      id={`plan-${decision.calculator}`}
      title={CALCULATOR_LABELS[decision.calculator]}
      icon={icon}
      tone={tone}
      badge={<Badge>Saved {formatDate(decision.created_at)}</Badge>}
    >
      <KVList>
        {decision.figures.map((figure) => (
          <KV key={figure.key} label={figure.label} value={figureText(figure)} />
        ))}
      </KVList>
      <ExplanationStatus decision={decision} />
    </DecisionCard>
  );
}
