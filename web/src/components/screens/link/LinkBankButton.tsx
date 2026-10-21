'use client';

import { useEffect, useRef, useState } from 'react';
import {
  usePlaidLink,
  type PlaidLinkError,
  type PlaidLinkOnSuccessMetadata,
} from 'react-plaid-link';
import { LinkIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { apiErrorMessage } from '@/lib/api/errors';
import { useCreateSyncItem, useLinkToken } from '@/lib/api/hooks';
import type { LinkedItem } from '@/lib/api/types';
import { loadPlaidScript, usePlaidScript } from '@/lib/plaid-script';

export interface LinkBankButtonProps {
  label: string;
  disabled?: boolean;
  /** The item is stored and its initial sync queued. */
  onLinked: (linked: LinkedItem, institution: string) => void;
  /** A sentence for the warning notice, or null to clear it. */
  onError: (message: string | null) => void;
}

const SCRIPT_FAILED = 'Could not load Plaid Link. Check your connection and reload the page.';

const exitMessage = (error: PlaidLinkError) =>
  `Plaid Link closed. ${error.display_message ?? error.error_message}`;

/**
 * Links a bank through Plaid Link. Plaid's script starts loading on mount
 * (`usePlaidScript`), so a press rarely waits for it. A press asks the API for
 * a link token, Plaid Link opens as soon as the script and the token are both
 * there, and the public token it returns is exchanged by `POST /sync/items`.
 * The button stays in its loading state from the press until Link is open or
 * the exchange is done, so the person always sees that something is happening.
 */
export function LinkBankButton({ label, disabled, onLinked, onError }: LinkBankButtonProps) {
  const script = usePlaidScript();
  const linkToken = useLinkToken();
  const createItem = useCreateSyncItem();
  // A token waiting for the script, then the token Link opens with.
  const [waitingForScript, setWaitingForScript] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [openedToken, setOpenedToken] = useState<string | null>(null);

  const onSuccess = (publicToken: string | null, metadata: PlaidLinkOnSuccessMetadata) => {
    setToken(null);
    if (!publicToken) {
      onError('Plaid Link finished without a connection. Try linking again.');
      return;
    }
    const institution = metadata.institution?.name ?? 'your bank';
    createItem.mutate(
      { publicToken, institutionName: metadata.institution?.name },
      {
        onSuccess: (linked) => onLinked(linked, institution),
        onError: (error) =>
          onError(`Could not link ${institution}. ${apiErrorMessage(error, 'Try again.')}`),
      },
    );
  };

  const onExit = (error: PlaidLinkError | null) => {
    setToken(null);
    if (error) onError(exitMessage(error));
  };

  const start = () => {
    onError(null);
    if (script === 'failed') {
      onError(SCRIPT_FAILED);
      return;
    }
    linkToken.mutate(undefined, {
      onSuccess: (created) => {
        // Usually loaded by now; otherwise Link opens when it is.
        setWaitingForScript(true);
        loadPlaidScript()
          .then(
            () => setToken(created.link_token),
            () => onError(SCRIPT_FAILED),
          )
          .finally(() => setWaitingForScript(false));
      },
      onError: (error) =>
        onError(`Could not start Plaid Link. ${apiErrorMessage(error, 'Try again shortly.')}`),
    });
  };

  const busy =
    linkToken.isPending ||
    waitingForScript ||
    (token !== null && openedToken !== token) ||
    createItem.isPending;

  return (
    <>
      <Button variant="primary" onClick={start} loading={busy} disabled={disabled}>
        <LinkIcon />
        {label}
      </Button>
      {token !== null && (
        <PlaidLinkOpener
          key={token}
          token={token}
          onSuccess={onSuccess}
          onExit={onExit}
          onOpen={setOpenedToken}
        />
      )}
    </>
  );
}

interface PlaidLinkOpenerProps {
  token: string;
  onSuccess: (publicToken: string | null, metadata: PlaidLinkOnSuccessMetadata) => void;
  onExit: (error: PlaidLinkError | null) => void;
  onOpen: (token: string) => void;
}

/**
 * Plaid Link for one token, mounted only once the script has run, so
 * react-plaid-link finds the script on the page instead of adding its own.
 * Opens Link as soon as Plaid is ready; renders nothing itself.
 */
function PlaidLinkOpener({ token, onSuccess, onExit, onOpen }: PlaidLinkOpenerProps) {
  const plaid = usePlaidLink({ token, onSuccess, onExit });
  // Open once: `open` changes identity as Plaid re-renders.
  const opened = useRef(false);
  useEffect(() => {
    if (!plaid.ready || opened.current) return;
    opened.current = true;
    plaid.open();
    onOpen(token);
  }, [plaid, token, onOpen]);
  return null;
}
