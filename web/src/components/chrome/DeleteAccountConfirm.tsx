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
  open: boolean;
  /** The dialog closed without deleting (Keep my account, Escape). */
  onClose: () => void;
}

/**
 * The confirmation for `DELETE /me` (spec 017) as a native modal `<dialog>`
 * (issue 242): `showModal()` gives it the dialog role, makes the rest of the
 * page inert (so Tab stays inside) and closes it on Escape, except while the
 * deletion is under way. It says what goes, asks for the word "delete", then
 * Delete my account. Success signs out and goes to `/sign-in?deleted=1`
 * (`useDeleteAccount`), so the button stays busy while the page unloads. Its
 * content mounts only while it is open, so it never reopens half typed.
 */
export function DeleteAccountConfirm({ open, onClose }: DeleteAccountConfirmProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-80 max-w-[calc(100vw-2rem)] rounded-tile border-0 bg-surface p-3 text-ink shadow-pop backdrop:bg-ink/30"
    >
      {open && (
        <Confirmation
          titleId={titleId}
          onBusy={setBusy}
          onKeep={() => dialogRef.current?.close()}
        />
      )}
    </dialog>
  );
}

function Confirmation({
  titleId,
  onBusy,
  onKeep,
}: {
  titleId: string;
  onBusy: (busy: boolean) => void;
  onKeep: () => void;
}) {
  const fieldId = useId();
  const [typed, setTyped] = useState('');
  const fieldRef = useRef<HTMLInputElement>(null);
  const remove = useDeleteAccount();
  const busy = remove.isPending || remove.isSuccess;
  const ready = isConfirmWord(typed);

  useEffect(() => fieldRef.current?.focus(), []);
  useEffect(() => onBusy(busy), [busy, onBusy]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !busy) remove.mutate();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-1">
      <h2 id={titleId} className="m-0 text-body font-semibold">
        Delete your account?
      </h2>
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
        <Button type="submit" variant="destructive" block disabled={!ready} loading={busy}>
          Delete my account
        </Button>
        <Button type="button" block onClick={onKeep} disabled={busy}>
          Keep my account
        </Button>
      </div>
    </form>
  );
}
