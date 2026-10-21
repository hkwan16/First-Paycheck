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

export interface LinkBankButtonProps {
  label: string;
  disabled?: boolean;
  /** The item is stored and its initial sync queued. */
  onLinked: (linked: LinkedItem, institution: string) => void;
  /** A sentence for the warning notice, or null to clear it. */
  onError: (message: string | null) => void;
}

const exitMessage = (error: PlaidLinkError) =>
  `Plaid Link closed. ${error.display_message ?? error.error_message}`;

/**
 * Links a bank through Plaid Link. A press asks the API for a link token,
 * Plaid Link opens as soon as its script is ready, and the public token it
 * returns is exchanged by `POST /sync/items`. The button stays in its loading
 * state from the press until Link is open or the exchange is done, so the
 * person always sees that something is happening.
 */
export function LinkBankButton({ label, disabled, onLinked, onError }: LinkBankButtonProps) {
  const linkToken = useLinkToken();
  const createItem = useCreateSyncItem();
  const [token, setToken] = useState<string | null>(null);
  // Open Link once per token: `open` changes identity as Plaid re-renders.
  const openedFor = useRef<string | null>(null);

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

  const plaid = usePlaidLink({
    token,
    onSuccess,
    onExit: (error) => {
      setToken(null);
      if (error) onError(exitMessage(error));
    },
  });

  useEffect(() => {
    if (token && plaid.ready && openedFor.current !== token) {
      openedFor.current = token;
      plaid.open();
    }
  }, [token, plaid]);

  // Plaid's script loads on mount, so by the time of a press a failure is known.
  const scriptFailed = plaid.error !== null && plaid.error !== undefined;

  const start = () => {
    onError(null);
    if (scriptFailed) {
      onError('Could not load Plaid Link. Check your connection and reload the page.');
      return;
    }
    linkToken.mutate(undefined, {
      onSuccess: (created) => setToken(created.link_token),
      onError: (error) =>
        onError(`Could not start Plaid Link. ${apiErrorMessage(error, 'Try again shortly.')}`),
    });
  };

  const busy =
    linkToken.isPending ||
    (token !== null && !plaid.ready && !scriptFailed) ||
    createItem.isPending;

  return (
    <Button variant="primary" onClick={start} loading={busy} disabled={disabled}>
      <LinkIcon />
      {label}
    </Button>
  );
}
