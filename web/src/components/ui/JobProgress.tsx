import type { components } from '@/lib/api/schema';
import type { Hue } from '@/lib/design/tone';
import { RefreshIcon } from '@/components/icons';
import { Bar } from './Bar';
import { Button } from './Button';
import { Notice } from './Notice';

type Job = components['schemas']['JobOut'];

export interface JobProgressProps {
  /** What the job is doing, e.g. "Syncing First Platypus Bank"; names the progressbar. */
  label: string;
  /** The latest `GET /jobs/{id}`; undefined before the first poll returns. */
  job: Job | undefined;
  /** The job could not be read (gone, or the API is unreachable). A dead job is failed too. */
  failed?: boolean;
  /** A sentence under the failure title, e.g. what happens to data already synced. */
  failedMessage?: string;
  /** Offers "Try again" when given. */
  onRetry?: () => void;
  /** The retry request is in flight. */
  retrying?: boolean;
  tone?: Hue;
}

function statusText(job: Job | undefined): string {
  if (!job) return 'Starting';
  switch (job.status) {
    case 'queued':
      return 'Waiting to start';
    case 'running':
      return 'Working';
    case 'succeeded':
      return 'Done';
    case 'dead':
      return 'Stopped';
  }
}

/**
 * A background job's progress: label, status, percent and a bar, updated on
 * every poll so the person sees continuous movement rather than a frozen
 * screen. Before the job reports a percent the bar is indeterminate, never a
 * made-up number. A dead or unreadable job becomes a warning with a retry.
 *
 * Only the status words sit in the polite live region; the percent changes
 * too often to announce and is read from the progressbar instead.
 */
export function JobProgress({
  label,
  job,
  failed = false,
  failedMessage,
  onRetry,
  retrying = false,
  tone = 'blue',
}: JobProgressProps) {
  if (failed || job?.status === 'dead') {
    return (
      <Notice tone="warning" compact role="alert" className="items-center">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span>
            <strong>{label} did not finish.</strong>
            {failedMessage && <> {failedMessage}</>}
          </span>
          {onRetry && (
            <Button size="sm" onClick={onRetry} loading={retrying}>
              <RefreshIcon />
              Try again
            </Button>
          )}
        </div>
      </Notice>
    );
  }

  const progress = job?.progress ?? 0;
  const succeeded = job?.status === 'succeeded';
  const determinate = succeeded || (job?.status === 'running' && progress > 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-small">
        <span className="font-semibold">{label}</span>
        <span className="flex items-baseline gap-2 text-ink-3">
          <span role="status" aria-live="polite">
            {statusText(job)}
          </span>
          {determinate && !succeeded && <span className="tabular-nums">{progress}%</span>}
        </span>
      </div>
      <Bar
        label={label}
        tone={tone}
        value={succeeded ? 100 : progress}
        indeterminate={!determinate}
      />
    </div>
  );
}
