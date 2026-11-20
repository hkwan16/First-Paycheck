import Link from 'next/link';
import { CheckIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { KV, KVList } from '@/components/ui/KV';
import { Notice } from '@/components/ui/Notice';
import type { PlanDecision } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { STEP_TEXT } from '@/lib/decision-steps';
import { calculatorIdOf, CALCULATOR_LABELS } from '@/lib/decisions';
import { decisionStepRoute, whyRoute } from '@/lib/routes';
import { CALCULATOR_CARDS, DecisionCard } from '../decisions/DecisionCard';
import { saveBadgeTone } from '../decisions/decision-format';
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
 * Why a saved decision needs review, in the API's words (spec 007 rule 19d),
 * and the way to its step, in place of its figures: they were worked out for
 * a paycheck or a year that is no longer the person's (spec 016 rule 3a).
 */
function NeedsReview({ decision }: { decision: PlanDecision }) {
  const id = calculatorIdOf(decision.calculator);
  return (
    <Notice tone="warning" compact>
      <ul className="m-0 list-none p-0">
        {decision.review.map((reason) => (
          <li key={reason.text}>{reason.text}</li>
        ))}
      </ul>
      <p className="mt-1 mb-0">
        Its numbers were worked out before this changed, so they are not shown here.{' '}
        <Link href={decisionStepRoute(id)}>Review your {STEP_TEXT[id].name}</Link>
      </p>
    </Notice>
  );
}

/**
 * One saved decision on the plan: when it was saved, the figures `GET /plan`
 * chose for its calculator (spec 016 rule 3), each by the API's label, and
 * its explanation status. A decision that needs review shows why instead of
 * its figures (rule 3a).
 */
export function DecisionSummary({ decision }: { decision: PlanDecision }) {
  const { icon, tone } = CALCULATOR_CARDS[calculatorIdOf(decision.calculator)];
  const review = decision.review.length > 0;
  return (
    <DecisionCard
      id={`plan-${decision.calculator}`}
      title={CALCULATOR_LABELS[decision.calculator]}
      icon={icon}
      tone={tone}
      badge={
        review ? (
          <Badge tone={saveBadgeTone('review')}>Needs review</Badge>
        ) : (
          // The person's day of the save, as the PDF prints it (spec 016 rule 11a, spec 019).
          <Badge>Saved {formatDate(decision.saved_on)}</Badge>
        )
      }
    >
      {review ? (
        <NeedsReview decision={decision} />
      ) : (
        <KVList>
          {decision.figures.map((figure) => (
            <KV key={figure.key} label={figure.label} value={figureText(figure)} />
          ))}
        </KVList>
      )}
      <ExplanationStatus decision={decision} />
    </DecisionCard>
  );
}
