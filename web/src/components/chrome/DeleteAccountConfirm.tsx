'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { apiErrorMessage } from '@/lib/api/errors';
import { useDeleteAccount } from '@/lib/api/hooks';

/** The word that confirms; capitals and surrounding spaces do not matter. */
export const CONFIRM_WORD = 'delete';

export const isConfirmWord = (text: string) => text.trim().toLowerCase() === CONFIRM_WORD;

export interface DeleteAccountConfirmProps {
  /** Keep the account: back to the menu. */
  onCancel: () => void;
}

/**
 * The account menu's in-page confirmation for `DELETE /me` (spec 017): what
 * goes, a field that must say "delete", then Delete my account. Success signs
 * out and goes to `/sign-in?deleted=1` (`useDeleteAccount`), so the button
 * stays busy while the page unloads.
 */
export function DeleteAccountConfirm({ onCancel }: DeleteAccountConfirmProps) {
  const titleId = useId();
  const fieldId = useId();
  const [typed, setTyped] = useState('');
  const fieldRef = useRef<HTMLInputElement>(null);
  const remove = useDeleteAccount();
  const busy = remove.isPending || remove.isSuccess;
  const ready = isConfirmWord(typed);

  useEffect(() => fieldRef.current?.focus(), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !busy) remove.mutate();
  };

  return (
    // A group around the form: `role="group"` is not allowed on a <form> itself.
    <div role="group" aria-labelledby={titleId} className="p-1">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p id={titleId} className="m-0 font-semibold">
          Delete your account?
        </p>
        <p className="m-0 text-small text-ink-2">
          This deletes your account and everything in it: linked banks, transactions, documents,
          decisions, goals and check-ins. It cannot be undone.
        </p>
        <div>
          <Label htmlFor={fieldId}>
            Type <strong className="font-bold text-ink">{CONFIRM_WORD}</strong> to confirm
          </Label>
          <Input
            ref={fieldRef}
            id={fieldId}
            value={typed}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            readOnly={busy}
            onChange={(event) => setTyped(event.currentTarget.value)}
          />
        </div>
        {remove.isError && (
          <p role="alert" className="m-0 text-small text-ink-2">
            Your account was not deleted.{' '}
            {apiErrorMessage(remove.error, 'Check your connection and try again.')}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <Button type="submit" variant="primary" block disabled={!ready} loading={busy}>
            Delete my account
          </Button>
          <Button type="button" block onClick={onCancel} disabled={busy}>
            Keep my account
          </Button>
        </div>
      </form>
    </div>
  );
}
