import Link from 'next/link';
import { AlertIcon, CheckIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { KV, KVList } from '@/components/ui/KV';
import { Notice } from '@/components/ui/Notice';
import type { PlanDecision } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { calculatorIdOf, CALCULATOR_LABELS } from '@/lib/decisions';
import { whyRoute } from '@/lib/routes';
import { CALCULATOR_CARDS, DecisionCard } from '../decisions/DecisionCard';
import { explanationView, figureText } from './plan-format';

/** Whether the decision's explanation was checked against the calculator, and where to read it. */
function ExplanationStatus({ decision }: { decision: PlanDecision }) {
  const why = whyRoute(decision.id);
  switch (explanationView(decision)) {
    case 'verified':
      return (
        <div>
          <Badge tone="confirmed" icon={<CheckIcon />} href={why}>
            Verified explanation
          </Badge>
        </div>
      );
    case 'fallback':
      return (
        <Notice tone="warning" compact icon={<AlertIcon size={14} />}>
          <strong>Explanation not verified.</strong>{' '}
          <Link href={why}>See the calculator&rsquo;s result</Link>
        </Notice>
      );
    case 'none':
      return (
        <p className="m-0 text-small text-ink-3">
          Explanation not written yet. <Link href={why}>Write it</Link>
        </p>
      );
    case 'unavailable':
      return null;
  }
}

/**
 * One saved decision on the plan: its version, the figures `GET /plan`
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
      badge={
        <Badge>
          v{decision.version} · Saved {formatDate(decision.created_at)}
        </Badge>
      }
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
