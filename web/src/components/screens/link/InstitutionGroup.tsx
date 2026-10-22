'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { RefreshIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { ListRows } from '@/components/ui/ListRows';
import { Notice } from '@/components/ui/Notice';
import { apiErrorMessage } from '@/lib/api/errors';
import { AccountRow } from './AccountRow';
import { ownedText, type InstitutionGroup as Group } from './account-format';

export interface InstitutionGroupProps {
  group: Group;
  /** Another sync is running: one at a time. */
  syncDisabled: boolean;
  syncPending: boolean;
  onSync: () => void;
  /** The confirmed unlink; AccountsCard owns it, since this group leaves when it lands. */
  onUnlink: () => void;
  unlinkPending: boolean;
  /** Why this institution's unlink failed, or null. */
  unlinkError: unknown;
}

/**
 * One linked institution: its name with Sync now and Unlink, then its
 * accounts. Unlinking deletes data, so it asks first, inline: focus moves to
 * the safe choice ("Keep"), and returns to Unlink if the person keeps it.
 */
export function InstitutionGroup({
  group,
  syncDisabled,
  syncPending,
  onSync,
  onUnlink,
  unlinkPending,
  unlinkError,
}: InstitutionGroupProps) {
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const unlinkRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const confirmId = useId();
  const { name, accounts } = group;

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      unlinkRef.current?.focus();
    }
  }, [confirming]);

  const keep = () => {
    returnFocus.current = true;
    setConfirming(false);
  };

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-micro font-semibold tracking-[0.06em] text-ink-3 uppercase">
          {name}
        </h3>
        {!confirming && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              aria-label={`Sync now for ${name}`}
              onClick={onSync}
              loading={syncPending}
              disabled={syncDisabled}
            >
              <RefreshIcon />
              Sync now
            </Button>
            <Button
              ref={unlinkRef}
              size="sm"
              aria-label={`Unlink ${name}`}
              onClick={() => setConfirming(true)}
            >
              Unlink
            </Button>
          </div>
        )}
      </div>

      {confirming && (
        <Notice
          tone="warning"
          compact
          role="group"
          aria-labelledby={confirmId}
          className="items-center"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span>
              <strong id={confirmId}>Unlink {name}?</strong> {ownedText(accounts.length)} will be
              deleted. You can link it again later.
            </span>
            <span className="flex flex-wrap gap-2">
              <Button ref={keepRef} size="sm" onClick={keep} disabled={unlinkPending}>
                Keep {name}
              </Button>
              <Button size="sm" variant="primary" loading={unlinkPending} onClick={onUnlink}>
                Yes, unlink {name}
              </Button>
            </span>
          </div>
        </Notice>
      )}
      {unlinkError != null && (
        <Notice tone="warning" compact role="alert">
          Could not unlink {name}.{' '}
          {apiErrorMessage(unlinkError, 'Check your connection and try again.')}
        </Notice>
      )}

      <ListRows>
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} />
        ))}
      </ListRows>
    </div>
  );
}
