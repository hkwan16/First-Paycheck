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
import { formatRate } from '@/lib/money';
import { CalculatorResultCard } from './CalculatorResultCard';
import { FallbackStatus, NextSteps, VerifiedBody, VerifiedStatus } from './ExplanationViews';
import { Sources } from './Sources';

const LEAD =
  "Written by the AI from the calculator's numbers and your benefits text, then checked by plain code before you see it.";

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
 * `POST /explain` answers when the run is over, verified or fallen back.
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

  let body: ReactNode;
  if (explanation.data) {
    body = explanation.data.verified ? (
      <Verified
        explanation={explanation.data}
        version={current?.version ?? null}
        taxYear={taxYearOf(current)}
        next={<NextSteps event={event} />}
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
            <Button size="sm" href="/setup/decisions">
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
        lead={LEAD}
      />
      {body}
    </>
  );
}

function Verified({
  explanation,
  version,
  taxYear,
  next,
}: {
  explanation: Explanation;
  version: number | null;
  taxYear: number | null;
  next: ReactNode;
}) {
  return (
    <>
      <VerifiedStatus explanation={explanation} />
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
