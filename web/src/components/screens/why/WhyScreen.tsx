'use client';

import type { ReactNode } from 'react';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorCode, apiErrorMessage } from '@/lib/api/errors';
import { useCalendar, useDecision, useExplain, useExplanation, usePayStubs } from '@/lib/api/hooks';
import type { Decision, Explanation } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { asK401Inputs, CALCULATOR_LABELS } from '@/lib/decisions';
import { isExplained } from '@/lib/explanations';
import { formatRate } from '@/lib/money';
import { decisionKindRoute, firstDecisionRoute } from '@/lib/routes';
import { CalculatorResultCard } from './CalculatorResultCard';
import {
  FallbackStatus,
  NextSteps,
  StaleStatus,
  VerifiedBody,
  VerifiedStatus,
} from './ExplanationViews';
import { Sources } from './Sources';

const LEAD =
  "Written by the AI from the calculator's numbers and your benefits text, then checked by plain code before you see it.";
// Spec 011 rule 18: a decision that is never explained.
const UNEXPLAINED_LEAD =
  'Worked out by the calculator from your own numbers. Nothing on this page came from a language model.';

function title(decision: Decision | undefined): string {
  const inputs = decision?.calculator === 'k401_match' ? asK401Inputs(decision.inputs) : null;
  return inputs
    ? `Why contribute ${formatRate(inputs.contribution_pct)} to your 401(k)`
    : 'Why this decision';
}

const taxYearOf = (decision: Decision | undefined): number | null => {
  const year = decision?.inputs.tax_year;
  return typeof year === 'number' ? year : null;
};

/**
 * "Why this decision", from docs/mockup/Why.dc.html, for one saved decision.
 * The explanation comes from `GET /decisions/{id}/explanation`: verified (the
 * AI's text, every number checked against the calculator) or a fallback (the
 * calculator's own result). With none yet, the person can ask for one;
 * `POST /explain` answers when the run is over, verified or fallen back. An
 * emergency fund is never explained (spec 011 rule 18): its page shows the
 * saved result and offers no explanation.
 */
export function WhyScreen({ decisionId }: { decisionId: string }) {
  const decision = useDecision(decisionId);
  const explanation = useExplanation(decisionId);
  const explain = useExplain();
  const calendar = useCalendar();
  const employer = usePayStubs().data?.[0]?.employer_name ?? 'Your employer';

  if (apiErrorCode(decision.error) === 'not_found') {
    return (
      <>
        <PageTitle title="Decision not found" lead="It may belong to another account." />
        <div>
          <Button href="/why" variant="primary">
            See your saved decisions
          </Button>
        </div>
      </>
    );
  }

  const current = decision.data;
  const write = (force: boolean) => explain.mutate({ decisionId, force });
  const event = calendar.data?.find((e) => e.decision_id === decisionId);
  const llmUnavailable = apiErrorCode(explain.error) === 'llm_unavailable';
  // Back to this decision's own step (spec 018 rule 4).
  const rerun = current ? decisionKindRoute(current.calculator) : firstDecisionRoute();

  const progress = explain.isPending && (
    <p role="status" className="m-0 text-small text-ink-3">
      Writing the explanation and checking its numbers. This can take up to half a minute.
    </p>
  );
  const explainError = explain.isError && (
    <ExplainError error={explain.error} llmUnavailable={llmUnavailable} />
  );
  const resultCard = (actions?: ReactNode) =>
    current && (
      <CalculatorResultCard
        decision={current}
        employer={employer}
        fallbackText={explanation.data?.text}
        actions={actions}
      />
    );

  const explained = current === undefined || isExplained(current.calculator);
  let body: ReactNode;
  if (current && !explained) {
    body = (
      <>
        <Card aria-labelledby="unexplained-title" gap={14}>
          <h2 id="unexplained-title" className="m-0">
            No written explanation
          </h2>
          <p className="m-0 text-small text-ink-3">
            An emergency fund is arithmetic on your own spending and savings, and no tax rule
            applies, so there is nothing to explain or cite. Here is what the calculator worked out
            when you saved it.
          </p>
        </Card>
        <CalculatorResultCard
          decision={current}
          employer={employer}
          fallback={false}
          actions={
            <Button size="sm" href={rerun}>
              Change it on its step
            </Button>
          }
        />
      </>
    );
  } else if (explanation.data) {
    // Out of date (spec 008 rule 19b): asked for again without force, so the
    // API answers with a current row another tab may already have written.
    const status = explanation.data.stale ? (
      <StaleStatus explanation={explanation.data}>
        <div>
          <Button variant="primary" loading={explain.isPending} onClick={() => write(false)}>
            Write it again
          </Button>
        </div>
        {progress}
        {explainError}
      </StaleStatus>
    ) : (
      <VerifiedStatus explanation={explanation.data} />
    );
    body = explanation.data.verified ? (
      <Verified
        explanation={explanation.data}
        status={status}
        version={current?.version ?? null}
        taxYear={taxYearOf(current)}
        next={<NextSteps event={event} rerun={rerun} />}
      />
    ) : (
      <>
        <FallbackStatus explanation={explanation.data} />
        {progress}
        {explainError}
        {resultCard(
          <>
            <Button size="sm" loading={explain.isPending} onClick={() => write(true)}>
              Try writing the explanation again
            </Button>
            <Button size="sm" href={rerun}>
              Re-run the calculator
            </Button>
          </>,
        )}
        <Sources citations={explanation.data.citations} taxYear={taxYearOf(current)} />
      </>
    );
  } else if (apiErrorCode(explanation.error) === 'not_found') {
    body = (
      <>
        <Card aria-labelledby="none-title" gap={14}>
          <h2 id="none-title" className="m-0">
            No explanation yet
          </h2>
          <p className="m-0 text-small text-ink-3">
            The AI writes it from the calculator&apos;s numbers and the curated IRS passages, and
            plain code checks every number before you see it.
          </p>
          {progress}
          <div>
            <Button variant="primary" loading={explain.isPending} onClick={() => write(false)}>
              Write the explanation
            </Button>
          </div>
        </Card>
        {explainError}
        {llmUnavailable && resultCard()}
      </>
    );
  } else if (explanation.isError) {
    body = (
      <Notice tone="warning" role="alert">
        {apiErrorMessage(explanation.error, 'Could not load the explanation. Reload to try again.')}
      </Notice>
    );
  } else {
    body = (
      <Card aria-label="Loading the explanation" aria-busy="true">
        <Skeleton className="w-1/2" />
        <Skeleton className="w-full" />
        <Skeleton className="w-5/6" />
      </Card>
    );
  }

  return (
    <>
      <PageTitle
        eyebrow={
          current && (
            <>
              <Badge>
                {CALCULATOR_LABELS[current.calculator]} · decision v{current.version}
              </Badge>
              <span className="text-small text-ink-3">Saved {formatDate(current.created_at)}</span>
            </>
          )
        }
        title={current ? title(current) : <Skeleton className="w-80 max-w-full" />}
        lead={explained ? LEAD : UNEXPLAINED_LEAD}
      />
      {body}
    </>
  );
}

function Verified({
  explanation,
  status,
  version,
  taxYear,
  next,
}: {
  explanation: Explanation;
  status: ReactNode;
  version: number | null;
  taxYear: number | null;
  next: ReactNode;
}) {
  return (
    <>
      {status}
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[1_1_460px] flex-col gap-6">
          <VerifiedBody explanation={explanation} version={version} />
        </div>
        <aside
          className="flex min-w-0 flex-[1_1_300px] flex-col gap-6"
          aria-label="Sources and next steps"
        >
          <Sources citations={explanation.citations} taxYear={taxYear} />
          {next}
        </aside>
      </div>
    </>
  );
}

function ExplainError({ error, llmUnavailable }: { error: unknown; llmUnavailable: boolean }) {
  if (llmUnavailable) {
    return (
      <Notice tone="blue" role="status" title="Explanations are not available yet.">
        The AI that writes them is not set up on this server. Your decision is saved, and its
        numbers come from the calculator, not the AI.
      </Notice>
    );
  }
  return (
    <Notice tone="warning" role="alert">
      {apiErrorMessage(error, 'Could not write the explanation. Try again.')}
    </Notice>
  );
}
