'use client';

import { useId, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Tile } from '@/components/ui/Tile';
import { apiErrorMessage } from '@/lib/api/errors';
import { useUpdateGoal } from '@/lib/api/hooks';
import { useFocusHandoff } from '@/lib/focus-handoff';
import type { Account, Goal, GoalPatch } from '@/lib/api/types';
import { formatRate } from '@/lib/money';
import { AmountField } from './AmountField';
import { amountText, readAmount } from './decision-format';
import {
  accountName,
  CONTRIBUTION_EXAMPLE,
  goalPace,
  goalStatusBadge,
  type GoalPaceContext,
} from './emergency-fund-format';

export interface EmergencyGoalProps extends GoalPaceContext {
  goal: Goal;
  /** To name the linked account. */
  accounts: readonly Account[];
}

/**
 * The emergency fund goal a saved decision made (`GET /goals`): what it
 * aims for, when its contribution reaches it (the API projects that again
 * when the contribution changes, spec 011 rule 17a), the linked account's
 * balance, and the changes `PATCH /goals/{id}` allows: pause or resume, mark
 * reached (or take that back), and a new monthly contribution. Every figure
 * is the API's.
 */
export function EmergencyGoal({ goal, accounts, funded, horizonMonths }: EmergencyGoalProps) {
  const id = useId();
  const update = useUpdateGoal();
  const [draft, setDraft] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const badge = goalStatusBadge(goal.status);
  const account = accounts.find((a) => a.id === goal.account_id);
  // Each action here swaps its own button for another control (issue 167).
  const focus = useFocusHandoff<'form' | 'change' | 'reached' | 'not-reached'>();

  const change = (patch: GoalPatch, onSuccess?: () => void) =>
    update.mutate({ goalId: goal.id, patch }, { onSuccess });

  const saveContribution = (event: FormEvent) => {
    event.preventDefault();
    const read = readAmount(draft ?? '', { example: CONTRIBUTION_EXAMPLE });
    if (read.cents === null) {
      setDraftError(read.error ?? `Enter an amount, like ${CONTRIBUTION_EXAMPLE}.`);
      return;
    }
    change({ monthly_contribution_cents: read.cents }, () => {
      focus.moveTo('change');
      setDraft(null);
    });
  };

  const pace = goalPace(goal, { funded, horizonMonths });

  return (
    <Tile role="group" aria-label="Your emergency fund goal" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-body font-semibold">Your goal</h3>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className="m-0 text-small">
        <Money cents={goal.monthly_contribution_cents} /> a month toward{' '}
        <Money cents={goal.target_amount_cents} />. {pace}
      </p>
      {goal.current_balance_cents !== null && account && (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-small text-ink-3">
            <Money cents={goal.current_balance_cents} /> in {accountName(account)}
            {goal.progress_pct !== null && <>, {formatRate(goal.progress_pct)} of the target</>}.
          </p>
          {goal.progress_pct !== null && (
            <Bar
              tone={goal.status === 'reached' ? 'confirmed' : 'teal'}
              value={Number(goal.progress_pct)}
              label="Goal progress"
              valueText={`${formatRate(goal.progress_pct)} of the target`}
              height={6}
            />
          )}
        </div>
      )}

      {draft !== null ? (
        <form
          ref={focus.target('form')}
          aria-label="Change the monthly contribution"
          noValidate
          onSubmit={saveContribution}
          className="flex flex-wrap items-end gap-3"
        >
          <AmountField
            id={`${id}-contribution`}
            label="New monthly contribution"
            value={draft}
            error={draftError}
            onChange={(text) => {
              setDraft(text);
              setDraftError(null);
            }}
            className="min-w-40 flex-1"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={update.isPending}>
              Save contribution
            </Button>
            <Button
              size="sm"
              onClick={() => {
                focus.moveTo('change');
                setDraft(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {goal.status === 'reached' ? (
            <Button
              ref={focus.target('not-reached')}
              size="sm"
              onClick={() => change({ status: 'active' }, () => focus.moveTo('reached'))}
            >
              Not reached yet
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => change({ status: goal.status === 'paused' ? 'active' : 'paused' })}
              >
                {goal.status === 'paused' ? 'Resume' : 'Pause'}
              </Button>
              <Button
                ref={focus.target('reached')}
                size="sm"
                onClick={() => change({ status: 'reached' }, () => focus.moveTo('not-reached'))}
              >
                Mark reached
              </Button>
              <Button
                ref={focus.target('change')}
                size="sm"
                onClick={() => {
                  focus.moveTo('form');
                  setDraft(amountText(goal.monthly_contribution_cents));
                  setDraftError(null);
                }}
              >
                Change contribution
              </Button>
            </>
          )}
        </div>
      )}

      {update.isError && (
        <Notice tone="warning" compact role="alert">
          {apiErrorMessage(update.error, 'Could not change your goal. Try again.')}
        </Notice>
      )}
    </Tile>
  );
}
