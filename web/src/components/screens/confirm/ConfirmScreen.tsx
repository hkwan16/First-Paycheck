'use client';

import { useState, type ReactNode } from 'react';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { ArrowRightIcon } from '@/components/icons';
import { apiErrorMessage } from '@/lib/api/errors';
import { isReviewable, useDocument } from '@/lib/api/hooks';
import type { Confirmed, DocumentDetail, DocumentType } from '@/lib/api/types';
import { documentTypeLabel, statusReasonText } from '@/lib/documents';
import { formatNumber } from '@/lib/money';
import { BenefitsReview } from './BenefitsReview';
import { ConfirmReview } from './ConfirmReview';

const PAY_STUB_TITLE = 'Check what we read from your pay stub';

/** The page title for a document of this type; anything but a benefits summary is a pay stub's. */
const titleFor = (type: DocumentType | undefined) =>
  type === 'benefits' ? 'Check what we read from your benefits summary' : PAY_STUB_TITLE;

function BackToDocuments() {
  return (
    <div>
      <Button href="/setup/link">Back to documents</Button>
    </div>
  );
}

function ToDecisions({ label }: { label: string }) {
  return (
    <div>
      <Button href="/setup/decisions" variant="primary">
        {label}
        <ArrowRightIcon />
      </Button>
    </div>
  );
}

/** A document that cannot be reviewed right now, with the way forward. */
function Status({ type, children }: { type?: DocumentType; children: ReactNode }) {
  return (
    <>
      <PageTitle title={titleFor(type)} />
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

/**
 * A benefits summary nothing could be read from. Its plans and match are not
 * typed in here: the health plan card and the 401(k) plan details take them.
 */
function BenefitsUnread() {
  return (
    <Status type="benefits">
      <Notice tone="warning" title="Nothing could be read from this summary.">
        Enter your health plans on the health plan card and your 401(k) match in its plan details.
        Both use only what you type.
      </Notice>
      <ToDecisions label="Go to decisions" />
    </Status>
  );
}

/** What confirming a benefits summary stored, from the server's answer. */
function BenefitsConfirmed({ result }: { result: Confirmed }) {
  const plans = result.plans.length;
  return (
    <Status type="benefits">
      <Notice tone="confirmed" title="Your benefits summary is confirmed.">
        {plans > 0 &&
          `${formatNumber(plans)} health ${plans === 1 ? 'plan is' : 'plans are'} ready to compare. `}
        {result.profile_updated && 'Your 401(k) match and vesting now come from this summary. '}
        The original file is deleted.
      </Notice>
      <ToDecisions label="Continue to decisions" />
    </Status>
  );
}

function NotReviewable({ document }: { document: DocumentDetail }) {
  const reason = statusReasonText(document.status_reason);
  const noun = documentTypeLabel(document.type).toLowerCase();
  if (document.type === 'offer_letter') {
    return (
      <Status>
        <Notice>
          Offer letters are kept but not read yet. Upload your first pay stub to review it here.
        </Notice>
        <BackToDocuments />
      </Status>
    );
  }
  switch (document.status) {
    case 'confirmed':
      return document.type === 'benefits' ? (
        <Status type="benefits">
          <Notice tone="confirmed" title="This benefits summary is confirmed.">
            The health plan comparison and the 401(k) card read the values you checked, and the
            original file is deleted.
          </Notice>
          <ToDecisions label="Continue to decisions" />
        </Status>
      ) : (
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
    case 'manual_entry_required':
      // A pay stub in manual entry is reviewable; only a benefits summary lands here.
      return <BenefitsUnread />;
    case 'extracting':
      return (
        <Status type={document.type}>
          <Card gap={12}>
            <div className="flex items-baseline justify-between gap-3 text-small">
              <span className="font-semibold">Reading {noun}</span>
              <span role="status" aria-live="polite" className="text-ink-3">
                Working
              </span>
            </div>
            <Bar label={`Reading ${noun}`} tone="blue" value={0} indeterminate />
            <p className="m-0 text-small text-ink-3">
              The redacted pages are being read. The fields appear here when they are ready.
            </p>
          </Card>
        </Status>
      );
    case 'failed':
      return (
        <Status type={document.type}>
          <Notice tone="warning" title="We could not read this file.">
            {reason ?? 'Upload it again as a PDF, PNG or JPEG.'}
          </Notice>
          <BackToDocuments />
        </Status>
      );
    default:
      return (
        <Status type={document.type}>
          <Notice>This {noun} has not been read yet. Start reading it from your documents.</Notice>
          <BackToDocuments />
        </Status>
      );
  }
}

/**
 * Setup step 2, from docs/mockup/Confirm.dc.html: check each field read from
 * the pay stub (or type each one when it could not be read) against the
 * redacted source, and confirm them. A benefits summary is reviewed the same
 * way, plan by plan. Only confirmed values are stored.
 */
export function ConfirmScreen({ documentId }: { documentId: string }) {
  const query = useDocument(documentId);
  // Kept here: confirming refetches the document as confirmed, which ends the review.
  const [benefitsResult, setBenefitsResult] = useState<Confirmed | null>(null);

  if (benefitsResult) return <BenefitsConfirmed result={benefitsResult} />;
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
  if (!isReviewable(document)) return <NotReviewable document={document} />;
  if (!document.proposal) {
    return (
      <Status type={document.type}>
        <Notice tone="warning" compact role="alert">
          This document has nothing to review yet. Try reading it again from your documents.
        </Notice>
        <BackToDocuments />
      </Status>
    );
  }
  if (document.type === 'benefits') {
    const { plans, match_tiers } = document.proposal;
    if (!plans?.length && !match_tiers?.length) return <BenefitsUnread />;
    return (
      <BenefitsReview
        key={document.id}
        document={document}
        proposal={document.proposal}
        onConfirmed={setBenefitsResult}
      />
    );
  }
  return <ConfirmReview key={document.id} document={document} proposal={document.proposal} />;
}
