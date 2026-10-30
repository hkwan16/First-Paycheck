'use client';

import { useId, useRef, type ChangeEvent } from 'react';
import { CheckIcon, DocumentIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { IconTile } from '@/components/ui/IconTile';
import { JobProgress } from '@/components/ui/JobProgress';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { isReviewable, useJob } from '@/lib/api/hooks';
import type { DocumentSummary, DocumentType } from '@/lib/api/types';
import { formatNumber } from '@/lib/money';
import { confirmRoute, decisionRouteFor } from '@/lib/routes';
import { documentStatusBadge, documentTypeLabel, statusReasonText } from '@/lib/documents';

/** The upload types the API can read today; an offer letter is stored only. */
export const READABLE_TYPES: ReadonlySet<DocumentType> = new Set(['pay_stub', 'benefits']);

/** What the documents list accepts: the extensions and the types they carry. */
export const DOCUMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

function ReadingProgress({
  label,
  jobId,
  onRetry,
  retrying,
}: {
  label: string;
  jobId: string | undefined;
  onRetry: () => void;
  retrying: boolean;
}) {
  const job = useJob(jobId);
  if (jobId) {
    return (
      <JobProgress
        label={label}
        job={job.data}
        failed={job.isFailed}
        failedMessage="The file is kept, so you can try again."
        onRetry={onRetry}
        retrying={retrying}
      />
    );
  }
  // Read by a job this page did not start (after a reload): the list is
  // polled instead, so there is no percent to show.
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-small">
        <span className="font-semibold">{label}</span>
        <span role="status" aria-live="polite" className="text-ink-3">
          Working
        </span>
      </div>
      <Bar label={label} tone="blue" value={0} indeterminate />
    </div>
  );
}

export interface DocumentRowProps {
  doc: DocumentSummary;
  /** The extraction job this page started for the document, if any. */
  jobId: string | undefined;
  /** An extraction is being requested for it right now. */
  starting: boolean;
  onRead: (doc: DocumentSummary) => void;
  onReplace: (doc: DocumentSummary, file: File) => void;
}

/**
 * One row of the mockup's documents list: what the document is, where it is
 * in the pipeline, how much was redacted, and what to do next.
 */
export function DocumentRow({ doc, jobId, starting, onRead, onReplace }: DocumentRowProps) {
  const titleId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const label = documentTypeLabel(doc.type);
  const lower = label.toLowerCase();
  const badge = documentStatusBadge(doc.status);
  const reason = statusReasonText(doc.status_reason);
  const reading = doc.status === 'extracting' || starting;
  const read = doc.page_count !== null;
  // A benefits summary nothing could be read from is not typed in on Confirm:
  // the decision cards take its plans and match (isReviewable).
  const unreadBenefits = doc.type === 'benefits' && doc.status === 'manual_entry_required';
  const pages =
    doc.page_count === null
      ? null
      : `${formatNumber(doc.page_count)} ${doc.page_count === 1 ? 'page' : 'pages'}`;

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) onReplace(doc, file);
  };

  return (
    <div role="group" aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <IconTile tone={doc.type === 'benefits' ? 'plum' : 'coral'}>
            <DocumentIcon />
          </IconTile>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span id={titleId} className="font-semibold">
                {label}
              </span>
              <Badge tone={reading ? 'blue' : badge.tone}>
                {reading ? documentStatusBadge('extracting').label : badge.label}
              </Badge>
            </div>
            <div className="text-small text-ink-3">
              {pages && `${pages} · `}
              {'uploaded '}
              <RelativeTime value={doc.uploaded_at} />
            </div>
            {reason && <p className="m-0 text-small text-ink-2">{reason}</p>}
            {unreadBenefits && (
              <p className="m-0 text-small text-ink-2">
                Enter its plans on the health plan card and its match in your 401(k) plan details.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {read && !reading && (
            <Badge
              tone={doc.redaction_count > 0 ? 'coral' : 'neutral'}
              icon={doc.redaction_count > 0 ? <CheckIcon /> : undefined}
            >
              {formatNumber(doc.redaction_count)} {doc.redaction_count === 1 ? 'item' : 'items'}{' '}
              redacted
            </Badge>
          )}
          {!reading && isReviewable(doc) && (
            <Button
              size="sm"
              href={confirmRoute(doc.id)}
              aria-label={doc.status === 'proposed' ? `Review ${lower}` : `Enter ${lower} fields`}
            >
              {doc.status === 'proposed' ? 'Review' : 'Enter fields'}
            </Button>
          )}
          {!reading && unreadBenefits && (
            <Button size="sm" href={decisionRouteFor('health_plan')}>
              Go to decisions
            </Button>
          )}
          {!reading && doc.status === 'uploaded' && READABLE_TYPES.has(doc.type) && (
            <Button size="sm" onClick={() => onRead(doc)} aria-label={`Read ${lower}`}>
              Read
            </Button>
          )}
          <Button
            size="sm"
            disabled={reading}
            onClick={() => fileInput.current?.click()}
            aria-label={`Replace ${lower}`}
          >
            Replace
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={DOCUMENT_ACCEPT}
            hidden
            tabIndex={-1}
            aria-label={`New ${lower} file`}
            onChange={onFile}
          />
        </div>
      </div>
      {reading && (
        <ReadingProgress
          label={`Reading ${lower}`}
          jobId={jobId}
          onRetry={() => onRead(doc)}
          retrying={starting}
        />
      )}
    </div>
  );
}
