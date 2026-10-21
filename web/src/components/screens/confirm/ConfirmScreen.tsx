'use client';

import type { ReactNode } from 'react';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { ArrowRightIcon } from '@/components/icons';
import { apiErrorMessage } from '@/lib/api/errors';
import { useDocument } from '@/lib/api/hooks';
import type { DocumentDetail } from '@/lib/api/types';
import { statusReasonText } from '@/lib/documents';
import { ConfirmReview } from './ConfirmReview';

const TITLE = 'Check what we read from your pay stub';

function BackToDocuments() {
  return (
    <div>
      <Button href="/setup/link">Back to documents</Button>
    </div>
  );
}

/** A document that cannot be reviewed right now, with the way forward. */
function Status({ children }: { children: ReactNode }) {
  return (
    <>
      <PageTitle title={TITLE} />
      {children}
    </>
  );
}

function Loading() {
  return (
    <Status>
      <Card aria-busy="true" gap={12}>
        <span className="sr-only">Loading the document</span>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex flex-col gap-1.5">
            <Skeleton className="w-28 text-small" />
            <Skeleton className="w-40" />
          </div>
        ))}
      </Card>
    </Status>
  );
}

function NotReviewable({ document }: { document: DocumentDetail }) {
  const reason = statusReasonText(document.status_reason);
  if (document.type !== 'pay_stub') {
    return (
      <Status>
        <Notice>
          {document.type === 'benefits'
            ? 'Benefits summaries are reviewed with your health plan decision, after alpha. Your pay stub is reviewed here.'
            : 'Offer letters are kept but not read yet. Upload your first pay stub to review it here.'}
        </Notice>
        <BackToDocuments />
      </Status>
    );
  }
  switch (document.status) {
    case 'confirmed':
      return (
        <Status>
          <Notice tone="confirmed" title="This pay stub is confirmed.">
            Calculators now read the values you checked, and the original file is deleted.
          </Notice>
          <div>
            <Button href="/setup/spending" variant="primary">
              Continue to spending
              <ArrowRightIcon />
            </Button>
          </div>
        </Status>
      );
    case 'extracting':
      return (
        <Status>
          <Card gap={12}>
            <div className="flex items-baseline justify-between gap-3 text-small">
              <span className="font-semibold">Reading pay stub</span>
              <span role="status" aria-live="polite" className="text-ink-3">
                Working
              </span>
            </div>
            <Bar label="Reading pay stub" tone="blue" value={0} indeterminate />
            <p className="m-0 text-small text-ink-3">
              The redacted pages are being read. The fields appear here when they are ready.
            </p>
          </Card>
        </Status>
      );
    case 'failed':
      return (
        <Status>
          <Notice tone="warning" title="We could not read this file.">
            {reason ?? 'Upload it again as a PDF, PNG or JPEG.'}
          </Notice>
          <BackToDocuments />
        </Status>
      );
    default:
      return (
        <Status>
          <Notice>
            This pay stub has not been read yet. Start reading it from your documents.
          </Notice>
          <BackToDocuments />
        </Status>
      );
  }
}

/**
 * Setup step 2, from docs/mockup/Confirm.dc.html: check each field read from
 * the pay stub (or type each one when it could not be read) against the
 * redacted source, and confirm them. Only confirmed values are stored.
 */
export function ConfirmScreen({ documentId }: { documentId: string }) {
  const query = useDocument(documentId);

  if (query.isPending) return <Loading />;
  if (query.isError) {
    return (
      <Status>
        <Notice tone="warning" compact role="alert">
          Could not load this document. {apiErrorMessage(query.error, 'Check your connection.')}
        </Notice>
        <BackToDocuments />
      </Status>
    );
  }

  const document = query.data;
  const reviewable =
    document.type === 'pay_stub' &&
    (document.status === 'proposed' || document.status === 'manual_entry_required');
  if (!reviewable) return <NotReviewable document={document} />;
  if (!document.proposal) {
    return (
      <Status>
        <Notice tone="warning" compact role="alert">
          This document has nothing to review yet. Try reading it again from your documents.
        </Notice>
        <BackToDocuments />
      </Status>
    );
  }
  return <ConfirmReview key={document.id} document={document} proposal={document.proposal} />;
}
