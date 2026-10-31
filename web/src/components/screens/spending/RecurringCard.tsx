'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FieldError } from '@/components/ui/FieldError';
import { Input } from '@/components/ui/Input';
import { ListRows } from '@/components/ui/ListRows';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorMessage } from '@/lib/api/errors';
import { useRecurring, useUpdateRecurring } from '@/lib/api/hooks';
import type { RecurringCharge, RecurringPatch } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { cancelOnEscape } from '@/lib/escape-cancel';
import { formatNumber } from '@/lib/money';
import { cadenceLabel, MAX_NAME, recurringBadge, renameError } from './recurring-format';

function RenameForm({
  charge,
  onSave,
  onCancel,
}: {
  charge: RecurringCharge;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const errorId = useId();
  const [name, setName] = useState(charge.merchant_clean);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = renameError(name);
    setError(problem);
    if (problem === null) onSave(name.trim());
  };

  return (
    <form onSubmit={submit} onKeyDown={cancelOnEscape(onCancel)} className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          className="w-56 max-w-full"
          aria-label={`New name for ${charge.merchant_clean}`}
          aria-describedby={error ? errorId : undefined}
          invalid={error !== null}
          maxLength={MAX_NAME + 20}
          value={name}
          autoFocus
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Button type="submit" size="sm" variant="primary">
          Save
        </Button>
        <Button type="button" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </form>
  );
}

function LoadingRows() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3.5">
      <span className="sr-only">Loading your recurring charges</span>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} block className="h-6 w-full" />
      ))}
    </div>
  );
}

/**
 * The charges that repeat (spec 009): each with its cadence, typical amount
 * and what the detector says about it (new, price changed, stopped). The
 * person can say one is not recurring, undo that, or rename it; each change
 * shows at once (`useUpdateRecurring` is optimistic) and goes back if the
 * server refuses it.
 */
export function RecurringCard() {
  const recurring = useRecurring();
  const update = useUpdateRecurring();
  const [editing, setEditing] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** The charge whose Rename button takes focus when it comes back. */
  const focusAfterEdit = useRef<string | null>(null);

  const charges = recurring.data ?? [];

  const save = (charge: RecurringCharge, patch: RecurringPatch) => {
    setFailure(null);
    update.mutate(
      { chargeId: charge.id, patch },
      {
        onError: (error) =>
          setFailure(
            `Could not save ${charge.merchant_clean}. It is back to how it was. ${apiErrorMessage(error, 'Try again.')}`,
          ),
      },
    );
  };

  const endEdit = (id: string) => {
    focusAfterEdit.current = id;
    setEditing(null);
  };

  let body;
  if (recurring.isPending) {
    body = <LoadingRows />;
  } else if (recurring.isError) {
    body = (
      <Notice tone="warning" compact role="alert" className="items-center">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            Could not load your recurring charges.{' '}
            {apiErrorMessage(recurring.error, 'Check your connection.')}
          </span>
          <Button size="sm" onClick={() => void recurring.refetch()}>
            Try again
          </Button>
        </div>
      </Notice>
    );
  } else if (charges.length === 0) {
    body = (
      <p className="m-0 text-small text-ink-3">
        Nothing recurring yet. A charge shows up here once it repeats on a weekly, monthly or yearly
        rhythm.
      </p>
    );
  } else {
    body = (
      <ListRows as="ul">
        {charges.map((charge) => {
          const badge = recurringBadge(charge);
          const ignored = charge.user_status === 'ignored';
          return (
            <li
              key={charge.id}
              aria-label={charge.merchant_clean}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
            >
              <div className={cn('flex min-w-0 flex-col', ignored && 'text-ink-3')}>
                {editing === charge.id ? (
                  <RenameForm
                    charge={charge}
                    onCancel={() => endEdit(charge.id)}
                    onSave={(name) => {
                      save(charge, { merchant_clean: name });
                      endEdit(charge.id);
                    }}
                  />
                ) : (
                  <span className="truncate font-semibold">{charge.merchant_clean}</span>
                )}
                <span className="text-tiny text-ink-3">
                  {cadenceLabel(charge.cadence)} · last {formatDate(charge.last_seen, 'short')}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Money
                  cents={charge.typical_amount_cents}
                  className={cn('font-semibold', ignored ? 'text-ink-3' : 'text-ink')}
                />
                <Badge tone={badge.tone}>{badge.text}</Badge>
                {ignored ? (
                  <Button size="sm" onClick={() => save(charge, { user_status: null })}>
                    Undo
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => save(charge, { user_status: 'ignored' })}>
                    Not recurring
                  </Button>
                )}
                {editing !== charge.id && (
                  <Button
                    size="sm"
                    ref={(el: HTMLButtonElement | null) => {
                      // Back from renaming: focus returns to this button.
                      if (el && focusAfterEdit.current === charge.id) {
                        focusAfterEdit.current = null;
                        el.focus();
                      }
                    }}
                    onClick={() => {
                      setFailure(null);
                      setEditing(charge.id);
                    }}
                  >
                    Rename
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ListRows>
    );
  }

  return (
    <Card aria-labelledby="recurring-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="recurring-title" className="m-0">
            Recurring charges
          </h2>
          <p className="m-0 text-small text-ink-3">
            Bills and subscriptions that repeat at a steady amount. Mark anything that is not one,
            or give it a clearer name.
          </p>
        </div>
        {charges.length > 0 && <Badge>{formatNumber(charges.length)} found</Badge>}
      </div>
      {body}
      {failure && (
        <Notice tone="warning" compact role="alert">
          {failure}
        </Notice>
      )}
    </Card>
  );
}
