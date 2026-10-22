'use client';

import { useId, useReducer, type Dispatch, type ReactNode } from 'react';
import { PageTitle } from '@/components/chrome/PageTitle';
import { StepFooter } from '@/components/chrome/StepFooter';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { apiErrorMessage } from '@/lib/api/errors';
import { useConfirmDocument } from '@/lib/api/hooks';
import type { Confirmed, DocumentDetail, Proposal } from '@/lib/api/types';
import { formatNumber } from '@/lib/money';
import { benefitsValues, initBenefitsState, reviewSections } from './benefits-fields';
import { confirmReducer, summarize, type ConfirmAction, type ReviewField } from './confirmReducer';
import { FieldRow } from './FieldRow';
import { SourcePane } from './SourcePane';

export interface BenefitsReviewProps {
  document: DocumentDetail;
  proposal: Proposal;
  /** The server stored the plans (and the match): the screen shows what changed. */
  onConfirmed: (result: Confirmed) => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h3 id={headingId} className="m-0 pt-3 text-body font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Review of one benefits summary (spec 013 rule 8), in the pay stub review's
 * frame: each plan, each 401(k) match tier and the vesting schedule as rows
 * to confirm or edit, beside the redacted lines the AI read. Only confirmed
 * values are sent; there is no arithmetic to check, so Continue needs only
 * every field confirmed. The server validates the plans (a deductible above
 * the out-of-pocket maximum is a 422) and has the final word.
 */
export function BenefitsReview({ document, proposal, onConfirmed }: BenefitsReviewProps) {
  const titleId = useId();
  const sourceId = useId();
  const [state, dispatchState] = useReducer(confirmReducer, proposal, initBenefitsState);
  const summary = summarize(state);
  const sections = reviewSections(state.fields);
  const confirm = useConfirmDocument();

  const dispatch: Dispatch<ConfirmAction> = (action) => {
    // An answer from the server describes the values it was sent; any change makes it stale.
    if (action.type !== 'select' && confirm.isError) confirm.reset();
    dispatchState(action);
  };

  const submit = () =>
    confirm.mutate(
      { documentId: document.id, benefits: benefitsValues(state.fields) },
      { onSuccess: onConfirmed },
    );

  const selected = state.fields.find((f) => f.key === state.selected) ?? null;
  const rows = (fields: readonly ReviewField[]) => (
    <div className="flex flex-col [&>*:first-child]:border-t-0">
      {fields.map((field) => (
        <FieldRow
          key={field.key}
          field={field}
          selected={field.key === state.selected}
          manual={false}
          sourceId={sourceId}
          dispatch={dispatch}
          emptyChoice="Not on the summary"
        />
      ))}
    </div>
  );

  let status: string | undefined;
  if (summary.remaining > 0) status = `${formatNumber(summary.remaining)} left to confirm`;
  else if (summary.editing > 0) status = 'Finish editing to continue';

  return (
    <>
      <PageTitle
        title="Check what we read from your benefits summary"
        lead="Each plan and the 401(k) match is a proposal until you confirm it. The health plan comparison and the 401(k) card only ever read confirmed values."
      />

      <div className="flex flex-wrap items-start gap-6">
        <Card aria-labelledby={titleId} gap={14} className="min-w-0 flex-[1_1_460px]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id={titleId} className="m-0">
                Plans and 401(k) match
              </h2>
              <div className="text-small text-ink-3">
                <span className="tabular-nums">{formatNumber(summary.confirmedCount)}</span> of{' '}
                <span className="tabular-nums">{formatNumber(summary.total)}</span> confirmed
              </div>
            </div>
            <Button
              size="sm"
              disabled={!summary.canConfirmAll}
              onClick={() => dispatch({ type: 'confirmAll' })}
            >
              Confirm all remaining
            </Button>
          </div>
          <Bar tone="confirmed" value={summary.progressPct} label="Fields confirmed" />

          {sections.plans.map((plan) => (
            <Section key={plan.fields[0]?.key ?? plan.title} title={plan.title}>
              {rows(plan.fields)}
            </Section>
          ))}

          <Section title="401(k) match">
            {sections.tiers.length === 0 ? (
              <p className="m-0 text-small text-ink-2">
                No 401(k) match was found in this summary, so your plan details keep the match you
                entered.
              </p>
            ) : (
              <>
                {sections.tiers.map((tier) => (
                  <div key={tier.title}>
                    <h4 className="m-0 pt-2 text-small font-semibold text-ink-2">{tier.title}</h4>
                    {rows(tier.fields)}
                  </div>
                ))}
                {sections.vesting && <div className="pt-2">{rows([sections.vesting])}</div>}
              </>
            )}
          </Section>

          {confirm.isError && (
            <Notice tone="warning" compact role="alert">
              Could not save these fields.{' '}
              {apiErrorMessage(confirm.error, 'Check your connection and try again.')}
            </Notice>
          )}
        </Card>

        <SourcePane
          id={sourceId}
          className="min-w-0 flex-[1_1_320px]"
          lines={proposal.source_lines ?? []}
          redactionCount={document.redaction_count}
          withheldPages={proposal.withheld_pages ?? []}
          selectedKey={state.selected}
          selectedLabel={selected?.label ?? null}
          linked={false}
          documentLabel="Redacted benefits summary"
        />
      </div>

      <StepFooter
        back={{ href: '/setup/link' }}
        next={{
          label: 'Confirm and continue',
          onClick: submit,
          disabled: !summary.canContinue,
          loading: confirm.isPending,
        }}
        status={status}
      />
    </>
  );
}
