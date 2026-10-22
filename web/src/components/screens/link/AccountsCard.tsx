'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CheckIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { JobProgress } from '@/components/ui/JobProgress';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorMessage } from '@/lib/api/errors';
import {
  useAccounts,
  useJob,
  useSandboxLink,
  useTriggerSync,
  useUnlinkItem,
} from '@/lib/api/hooks';
import type { Job, LinkedItem, SyncProvider } from '@/lib/api/types';
import { formatNumber } from '@/lib/money';
import {
  groupByInstitution,
  ownedText,
  removalWords,
  type InstitutionGroup as Group,
} from './account-format';
import { CsvImport } from './CsvImport';
import { InstitutionGroup } from './InstitutionGroup';
import { LinkBankButton } from './LinkBankButton';

interface ActiveSync {
  jobId: string;
  itemId: string;
  institution: string;
  /** A new link (initial sync) or a sync the person asked for. */
  kind: 'link' | 'sync';
}

/** The institution being unlinked, kept for the done notice: its rows leave with it. */
interface Unlinking {
  itemId: string;
  name: string;
  provider: SyncProvider;
  count: number;
}

/** The sync job's own counts, read defensively: `result` is free-form JSON. */
function resultNumber(job: Job, key: string): number | null {
  const value = job.result?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function SyncOutcome({ job, active }: { job: Job; active: ActiveSync }) {
  if (job.result?.outcome === 'login_required') {
    return (
      <Notice tone="warning" compact role="alert">
        {active.institution} asked you to sign in again. Link it again to keep syncing.
      </Notice>
    );
  }
  const added = resultNumber(job, 'added');
  const synced =
    added === null
      ? ''
      : ` ${formatNumber(added)} new ${added === 1 ? 'transaction' : 'transactions'} synced.`;
  return (
    <Notice tone="confirmed" compact role="status">
      {active.kind === 'link' ? `Linked ${active.institution}.` : `Synced ${active.institution}.`}
      {synced}
    </Notice>
  );
}

function LoadingRows() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3.5">
      <span className="sr-only">Loading your accounts</span>
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-3">
          <Skeleton block className="size-9 rounded-control" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="w-48" />
            <Skeleton className="w-64 text-small" />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface AccountsCardProps {
  showSandboxLink: boolean;
}

/**
 * The mockup's "Bank accounts" card: linked accounts grouped by institution,
 * the active sync's progress, and the ways to link another bank.
 */
export function AccountsCard({ showSandboxLink }: AccountsCardProps) {
  const accounts = useAccounts();
  const sandbox = useSandboxLink();
  const trigger = useTriggerSync();
  const unlink = useUnlinkItem();
  const [active, setActive] = useState<ActiveSync | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<Unlinking | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const csvPanelId = useId();
  const doneRef = useRef<HTMLDivElement>(null);
  const job = useJob(active?.jobId);

  const list = accounts.data ?? [];
  // The institution unlinked last, once the server said so and the list was read again.
  const unlinked = unlink.isSuccess && unlinking?.itemId === unlink.variables ? unlinking : null;
  // A sync of an institution that is gone has nothing left to show.
  const shown = active && active.itemId !== unlinked?.itemId ? active : null;
  const syncing = shown !== null && !job.isTerminal && !job.isFailed;

  // The Unlink button left with its institution: focus the notice that replaced it.
  useEffect(() => {
    if (unlinked) doneRef.current?.focus();
  }, [unlinked]);

  const startUnlink = (group: Group) => {
    setLinkError(null);
    setUnlinking({
      itemId: group.itemId,
      name: group.name,
      provider: group.provider,
      count: group.accounts.length,
    });
    unlink.mutate(group.itemId);
  };

  const onLinked = (linked: LinkedItem, institution: string) =>
    setActive({
      jobId: linked.job_id,
      itemId: linked.item.id,
      institution: linked.item.institution_name ?? institution,
      kind: 'link',
    });

  const startSync = (itemId: string, institution: string, kind: ActiveSync['kind']) => {
    setLinkError(null);
    trigger.mutate(itemId, {
      onSuccess: ({ job_id }) => setActive({ jobId: job_id, itemId, institution, kind }),
      onError: (error) =>
        setLinkError(`Could not sync ${institution}. ${apiErrorMessage(error, 'Try again.')}`),
    });
  };

  const linkSandbox = () => {
    setLinkError(null);
    sandbox.mutate(undefined, {
      onSuccess: (linked) => onLinked(linked, 'the sandbox bank'),
      onError: (error) =>
        setLinkError(`Could not link the sandbox bank. ${apiErrorMessage(error, 'Try again.')}`),
    });
  };

  let body;
  if (accounts.isPending) {
    body = <LoadingRows />;
  } else if (accounts.isError) {
    body = (
      <Notice tone="warning" compact role="alert" className="items-center">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            Could not load your accounts.{' '}
            {apiErrorMessage(accounts.error, 'Check your connection.')}
          </span>
          <Button size="sm" onClick={() => void accounts.refetch()}>
            Try again
          </Button>
        </div>
      </Notice>
    );
  } else if (list.length === 0) {
    body = (
      <p className="m-0 text-small text-ink-3">
        No accounts linked yet. Link the account your paycheck lands in, and any savings you keep
        for emergencies.
      </p>
    );
  } else {
    body = groupByInstitution(list).map((group) => (
      <InstitutionGroup
        key={group.itemId}
        group={group}
        syncDisabled={syncing || trigger.isPending}
        syncPending={trigger.isPending && trigger.variables === group.itemId}
        onSync={() => startSync(group.itemId, group.name, 'sync')}
        onUnlink={() => startUnlink(group)}
        unlinkPending={unlink.isPending && unlink.variables === group.itemId}
        unlinkError={unlink.isError && unlink.variables === group.itemId ? unlink.error : null}
      />
    ));
  }

  return (
    <Card aria-labelledby="accounts-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="accounts-title" className="m-0">
          Bank accounts
        </h2>
        {list.length > 0 && (
          <Badge tone="confirmed" icon={<CheckIcon />}>
            {formatNumber(list.length)} linked
          </Badge>
        )}
      </div>

      {body}

      {unlinked && (
        <Notice ref={doneRef} tabIndex={-1} tone="confirmed" compact role="status">
          {removalWords(unlinked.provider).done} {unlinked.name}. {ownedText(unlinked.count)} were
          deleted.
        </Notice>
      )}

      {shown &&
        (job.isTerminal && job.data && !job.isFailed ? (
          <SyncOutcome job={job.data} active={shown} />
        ) : (
          <JobProgress
            label={`Syncing ${shown.institution}`}
            job={job.data}
            failed={job.isFailed}
            failedMessage="Anything already synced is kept."
            onRetry={() => startSync(shown.itemId, shown.institution, shown.kind)}
            retrying={trigger.isPending}
          />
        ))}

      {linkError && (
        <Notice tone="warning" compact role="alert">
          {linkError}
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <LinkBankButton
          label={list.length > 0 ? 'Link another bank with Plaid' : 'Link a bank with Plaid'}
          disabled={syncing}
          onLinked={onLinked}
          onError={setLinkError}
        />
        {showSandboxLink && (
          <Button onClick={linkSandbox} loading={sandbox.isPending} disabled={syncing}>
            Link sandbox bank (test)
          </Button>
        )}
        <Button
          aria-expanded={csvOpen}
          aria-controls={csvOpen ? csvPanelId : undefined}
          onClick={() => setCsvOpen((open) => !open)}
        >
          Import a CSV
        </Button>
        <span className="text-small text-ink-3">
          A CSV goes through the same pipeline as a linked account.
        </span>
      </div>
      {csvOpen && <CsvImport id={csvPanelId} />}
    </Card>
  );
}
