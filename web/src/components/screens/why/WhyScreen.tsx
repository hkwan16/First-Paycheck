'use client';

import type { ReactNode } from 'react';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorCode, apiErrorMessage } from '@/lib/api/errors';
import {
  useCalendar,
  useDecision,
  useDecisions,
  useExplain,
  useExplanation,
  usePayStubs,
} from '@/lib/api/hooks';
import type { Decision, Explanation } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { asK401Inputs, CALCULATOR_LABELS } from '@/lib/decisions';
import { isExplained } from '@/lib/explanations';
import { formatRate } from '@/lib/money';
import { decisionKindRoute, firstDecisionRoute, whyRoute } from '@/lib/routes';
import { CalculatorResultCard } from './CalculatorResultCard';
import {
  CheckedNote,
  NextSteps,
  NotWrittenNote,
  ReplacedNote,
  StaleNote,
  VerifiedBody,
} from './ExplanationViews';
import { Sources } from './Sources';

const LEAD = 'What this decision means for your money, and the rules behind it.';
// Spec 011 rule 18: a decision that is never explained.
const UNEXPLAINED_LEAD =
  'An emergency fund has no tax rules behind it, so this page shows the numbers you saved.';

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
 * The explanation comes from `GET /decisions/{id}/explanation`: verified
 * (every number checked against the saved decision) or one that could not be
 * written (the saved numbers instead). With none yet, the person can ask for
 * one; `POST /explain` answers when the run is over. One note says which
 * state it is in (spec 008 rule 19b). An emergency fund is never explained
 * (spec 011 rule 18): its page shows the saved result and offers no
 * explanation. A version a newer one replaced says so in place of that note,
 * links to the current one and offers nothing that acts on it (spec 008 rule
 * 19c).
 */
export function WhyScreen({ decisionId }: { decisionId: string }) {
  const decision = useDecision(decisionId);
  const decisions = useDecisions();
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
  // Spec 008 rule 19c (issue 227): a version a newer one replaced is kept as a
  // record. It says so, links to the current one, and offers nothing that acts
  // on the current decision or writes an explanation.
  const replaced = current?.is_current === false;
  const latest = replaced
    ? decisions.data?.items.find((item) => item.calculator === current.calculator)?.current
    : undefined;
  const replacedNote = replaced && (
    <ReplacedNote
      savedOn={current.created_at}
      replacedOn={latest?.created_at}
      current={latest ? whyRoute(latest.id) : '/why'}
    />
  );
  const write = (force: boolean) => explain.mutate({ decisionId, force });
  const event = calendar.data?.find((e) => e.decision_id === decisionId);
  const llmUnavailable = apiErrorCode(explain.error) === 'llm_unavailable';
  // Back to this decision's own step (spec 018 rule 4).
  const change = current ? decisionKindRoute(current.calculator) : firstDecisionRoute();
  const changeButton = !replaced && (
    <Button size="sm" href={change}>
      Change this decision
    </Button>
  );

  const progress = explain.isPending && (
    <p role="status" className="m-0 text-small text-ink-3">
      Writing the explanation and checking its numbers. This can take up to half a minute.
    </p>
  );
  const explainError = explain.isError && (
    <ExplainError error={explain.error} llmUnavailable={llmUnavailable} />
  );
  const savedNumbers = (actions?: ReactNode) =>
    current && (
      <CalculatorResultCard
        decision={current}
        employer={employer}
        fallbackText={explanation.data?.text}
        actions={actions}
      />
    );
  const writeButton = (force: boolean, label: string) => (
    <Button size="sm" loading={explain.isPending} onClick={() => write(force)}>
      {label}
    </Button>
  );

  const explained = current === undefined || isExplained(current.calculator);
  let body: ReactNode;
  if (current && !explained) {
    body = (
      <>
        {replacedNote}
        {savedNumbers(changeButton)}
      </>
    );
  } else if (explanation.data?.verified) {
    // Out of date (spec 008 rule 19b): asked for again without force, so the
    // API answers with a current row another tab may already have written.
    const note = replacedNote ? (
      replacedNote
    ) : explanation.data.stale ? (
      <StaleNote explanation={explanation.data} action={writeButton(false, 'Write it again')} />
    ) : (
      <CheckedNote explanation={explanation.data} />
    );
    body = (
      <Verified
        explanation={explanation.data}
        note={
          <>
            {note}
            {progress}
            {explainError}
          </>
        }
        taxYear={taxYearOf(current)}
        next={!replaced && <NextSteps event={event} change={change} />}
      />
    );
  } else if (explanation.data) {
    body = (
      <>
        {replacedNote || (
          <NotWrittenNote explanation={explanation.data} action={writeButton(true, 'Try again')} />
        )}
        {progress}
        {explainError}
        {savedNumbers(changeButton)}
        <Sources citations={explanation.data.citations} taxYear={taxYearOf(current)} />
      </>
    );
  } else if (replaced && apiErrorCode(explanation.error) === 'not_found') {
    body = (
      <>
        {replacedNote}
        <Card aria-labelledby="none-title" gap={14}>
          <h2 id="none-title" className="m-0">
            No explanation
          </h2>
          <p className="m-0 text-small text-ink-3">
            No explanation was written for this decision before it was replaced.
          </p>
        </Card>
        {savedNumbers()}
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
            We write it from the decision you saved and the IRS rules behind it, and check every
            number before you see it.
          </p>
          {progress}
          <div>
            <Button variant="primary" loading={explain.isPending} onClick={() => write(false)}>
              Write the explanation
            </Button>
          </div>
        </Card>
        {explainError}
        {llmUnavailable && savedNumbers()}
      </>
    );
  } else if (explanation.isError) {
    body = (
      <Notice tone="warning" role="alert">
        {apiErrorMessage(
          explanation.error,
          'We could not load the explanation. Reload the page to try again.',
        )}
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
              <Badge>{CALCULATOR_LABELS[current.calculator]}</Badge>
              <span className="text-small text-ink-3">Saved {formatDate(current.created_at)}</span>
              {replaced && <Badge>Replaced</Badge>}
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
  note,
  taxYear,
  next,
}: {
  explanation: Explanation;
  note: ReactNode;
  taxYear: number | null;
  next: ReactNode;
}) {
  return (
    <>
      {note}
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[1_1_460px] flex-col gap-6">
          <VerifiedBody explanation={explanation} />
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
      <Notice tone="blue" role="status" title="Explanations are not available right now.">
        Your decision is still saved.
      </Notice>
    );
  }
  return (
    <Notice tone="warning" role="alert">
      {apiErrorMessage(error, 'We could not write the explanation. Try again.')}
    </Notice>
  );
}
