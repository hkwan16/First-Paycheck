'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useId, useReducer, type Dispatch } from 'react';
import { PageTitle } from '@/components/chrome/PageTitle';
import { StepFooter } from '@/components/chrome/StepFooter';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { apiErrorMessage } from '@/lib/api/errors';
import { PayStubUnbalanced, useConfirmDocument } from '@/lib/api/hooks';
import type { DocumentDetail, PayStubValues, Proposal } from '@/lib/api/types';
import { formatNumber } from '@/lib/money';
import { statusReasonText } from '@/lib/documents';
import {
  confirmReducer,
  initConfirmState,
  payStubValues,
  summarize,
  type ConfirmAction,
} from './confirmReducer';
import { FIELD_CHOICES } from './field-format';
import { FieldRow } from './FieldRow';
import { GateNotice, ServerDiff } from './MathNotice';
import { SourcePane } from './SourcePane';

export interface ConfirmReviewProps {
  document: DocumentDetail;
  proposal: Proposal;
}

/**
 * Review of one pay stub: the fields card and the source pane side by side,
 * then the footer. Its state lives in `confirmReducer`, created once per
 * document, so a refetch of the document never drops what the person typed.
 */
export function ConfirmReview({ document, proposal }: ConfirmReviewProps) {
  const router = useRouter();
  const titleId = useId();
  const sourceId = useId();
  const manual = document.status === 'manual_entry_required';
  const [state, dispatchState] = useReducer(confirmReducer, undefined, () =>
    initConfirmState(proposal.fields ?? [], { manual, choices: FIELD_CHOICES }),
  );
  const summary = summarize(state);
  const confirm = useConfirmDocument({ onConfirmed: () => router.push('/setup/spending') });

  // Stable, so a memoized FieldRow renders again only when its own field changes.
  const { isError, reset } = confirm;
  const dispatch = useCallback<Dispatch<ConfirmAction>>(
    (action) => {
      // An answer from the server describes the values it was sent; any change makes it stale.
      if (action.type !== 'select' && isError) reset();
      dispatchState(action);
    },
    [isError, reset],
  );

  const submit = () =>
    // The fields are the API's own keys for this document type; the server validates them.
    confirm.mutate({
      documentId: document.id,
      values: payStubValues(state.fields) as unknown as PayStubValues,
    });

  const selected = state.fields.find((f) => f.key === state.selected) ?? null;
  const reason = statusReasonText(document.status_reason);

  let status: string | undefined;
  if (summary.remaining > 0) status = `${formatNumber(summary.remaining)} left to confirm`;
  else if (summary.editing > 0) status = 'Finish editing to continue';
  else if (!summary.canContinue) status = 'Fix the amounts to continue';

  return (
    <>
      <PageTitle
        title={manual ? 'Enter what your pay stub says' : 'Check what we read from your pay stub'}
        lead={
          manual
            ? 'Type each field from the redacted lines beside it. Calculators only ever read values you confirm.'
            : 'Each field is a proposal until you confirm it. Calculators only ever read confirmed values. Select a field to see where it came from.'
        }
      />
      {manual && reason && <Notice tone="warning">{reason}</Notice>}

      <div className="flex flex-wrap items-start gap-6">
        <Card aria-labelledby={titleId} gap={14} className="min-w-0 flex-[1_1_460px]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id={titleId} className="m-0">
                {manual ? 'Pay stub fields' : 'Extracted fields'}
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

          <div className="flex flex-col [&>*:first-child]:border-t-0">
            {state.fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                selected={field.key === state.selected}
                manual={manual}
                sourceId={sourceId}
                dispatch={dispatch}
              />
            ))}
          </div>

          <div aria-live="polite">
            <GateNotice gate={summary.gate} />
          </div>
          {confirm.error instanceof PayStubUnbalanced ? (
            <ServerDiff balance={confirm.error.balance} />
          ) : (
            confirm.isError && (
              <Notice tone="warning" compact role="alert">
                Could not save these fields.{' '}
                {apiErrorMessage(confirm.error, 'Check your connection and try again.')}
              </Notice>
            )
          )}
        </Card>

        <SourcePane
          id={sourceId}
          className="min-w-0 flex-[1_1_320px]"
          lines={proposal.source_lines}
          redactionCount={document.redaction_count}
          withheldPages={proposal.withheld_pages}
          selectedKey={state.selected}
          selectedLabel={selected?.label ?? null}
          manual={manual}
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
