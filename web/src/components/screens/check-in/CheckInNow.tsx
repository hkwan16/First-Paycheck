'use client';

import Link from 'next/link';
import { RefreshIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { JobProgress } from '@/components/ui/JobProgress';
import { Notice } from '@/components/ui/Notice';
import { apiErrorMessage } from '@/lib/api/errors';
import type { CheckInNowState } from '@/lib/api/hooks';
import { cn } from '@/lib/cn';
import { checkInRoute } from '@/lib/routes';

const PROGRESS_LABEL = 'Checking in';

/** The run is queued or under way: the button keeps its place and waits. */
const isBusy = (state: CheckInNowState) =>
  state.isStarting ||
  (state.jobId !== null && state.outcome === null && !state.job.isFailed && !state.job.isTerminal);

/**
 * The mockup's "Run again now" (CheckIn.dc.html's title row): starts this
 * month's check-in run (`useCheckInNow`). Its progress and outcome are
 * `CheckInNowStatus`, under the title.
 */
export function CheckInNowButton({ state }: { state: CheckInNowState }) {
  return (
    <Button onClick={state.start} loading={isBusy(state)}>
      <RefreshIcon />
      Check in now
    </Button>
  );
}

/**
 * What "Check in now" is doing: the job's progress while it runs (a dead
 * one offers Try again), why a start was refused (a 429 in the shared limits
 * sentence), and, in a polite status line that is always rendered, what the
 * finished run did. `from` says where the person pressed it: on the list the
 * line links to the check-in; on the check-in itself the page has just been
 * read again, so it says that instead.
 */
export function CheckInNowStatus({
  state,
  from,
}: {
  state: CheckInNowState;
  from: 'list' | 'check-in';
}) {
  const { outcome, checkInId } = state;
  const link =
    from === 'list' && checkInId !== null && outcome !== 'skipped' ? (
      <>
        {' '}
        <Link href={checkInRoute(checkInId)}>Open it</Link>
      </>
    ) : null;

  let message = '';
  if (outcome === 'skipped') {
    message = 'This month’s check-in is already complete, so nothing was changed.';
  } else if (outcome !== null && from === 'check-in') {
    message = 'Checked again just now. This page is up to date.';
  } else if (outcome === 'created') {
    message = 'This month’s check-in is ready.';
  } else if (outcome === 'refreshed') {
    message = 'This month’s check-in is up to date.';
  }

  return (
    <>
      {state.startError !== null && !state.isStarting && (
        <Notice tone="warning" compact role="alert">
          Could not check in now.{' '}
          {apiErrorMessage(state.startError, 'The server could not be reached. Try again.')}
        </Notice>
      )}
      {state.jobId !== null && outcome === null && (
        <JobProgress
          label={PROGRESS_LABEL}
          job={state.job.data}
          failed={state.job.isFailed}
          failedMessage="Nothing was changed."
          onRetry={state.start}
          retrying={state.isStarting}
        />
      )}
      {/* Always rendered, so the polite region exists before its text arrives. */}
      <p role="status" className={cn('m-0 text-small', message ? 'text-ink-3' : 'sr-only')}>
        {message}
        {message && link}
      </p>
    </>
  );
}
