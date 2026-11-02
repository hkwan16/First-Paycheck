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
import { documentTypeLabel, statusReasonText, SUPERSEDED_TEXT } from '@/lib/documents';
import { formatNumber } from '@/lib/money';
import { pageTitle } from '@/lib/page-title';
import { confirmRoute, decisionRouteFor } from '@/lib/routes';
import { BenefitsReview } from './BenefitsReview';
import { ConfirmReview } from './ConfirmReview';
import { ReadAgain } from './ReadAgain';

const PAY_STUB_TITLE = 'Check what we read from your pay stub';
const BENEFITS_CONFIRMED = 'Your benefits summary is confirmed';

/** The page title for a document of this type; anything but a benefits summary is a pay stub's. */
const titleFor = (type: DocumentType | undefined) =>
  type === 'benefits' ? 'Check what we read from your benefits summary' : PAY_STUB_TITLE;

/** The browser tab's title: "Confirm" and the document's type. */
const tabTitleFor = (type: DocumentType) =>
  pageTitle(`Confirm ${documentTypeLabel(type).toLowerCase()}`);

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
      <Button href={decisionRouteFor('health_plan')} variant="primary">
        {label}
        <ArrowRightIcon />
      </Button>
    </div>
  );
}

/**
 * A document with nothing to check right now, with the way forward. The title
 * says what state it is in, so a confirmed document never reads as a review
 * (issue 209).
 */
function Status({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <PageTitle title={title} />
      {children}
    </>
  );
}

function Loading() {
  return (
    <Status title={PAY_STUB_TITLE}>
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
function BenefitsUnread({ document }: { document: DocumentDetail }) {
  return (
    <Status title={titleFor('benefits')}>
      <Notice tone="warning" title="We could not read this summary.">
        {document.can_read_again && `${statusReasonText(document.status_reason)} `}
        Enter your health plans on the health plan step and your 401(k) match in its plan details.
      </Notice>
      {document.can_read_again && <ReadAgain document={document} />}
      <ToDecisions label="Go to decisions" />
    </Status>
  );
}

/** What confirming a benefits summary stored, from the server's answer. */
function BenefitsConfirmed({ result }: { result: Confirmed }) {
  const plans = result.plans.length;
  return (
    <Status title={BENEFITS_CONFIRMED}>
      <Notice tone="confirmed">
        {plans > 0 &&
          `${formatNumber(plans)} health ${plans === 1 ? 'plan is' : 'plans are'} ready to compare. `}
        {result.profile_updated && 'Your 401(k) match and vesting now come from this summary. '}
        We deleted the file.
      </Notice>
      <ToDecisions label="Continue to decisions" />
    </Status>
  );
}

/**
 * A document a newer upload replaced (spec 004 rule 27): its file is gone and
 * it cannot be confirmed, so point to the document that took its place.
 */
function Replaced({ type, replacedBy }: { type: DocumentType; replacedBy: string }) {
  const noun = documentTypeLabel(type).toLowerCase();
  return (
    <Status title={titleFor(type)}>
      <Notice title={`This ${noun} was replaced by a newer upload.`}>
        We deleted its file when the new one arrived, so there is nothing to check here.
      </Notice>
      <div className="flex flex-wrap gap-3">
        <Button href={confirmRoute(replacedBy)} variant="primary">
          Open the new {noun}
          <ArrowRightIcon />
        </Button>
        <Button href="/setup/link">Back to documents</Button>
      </div>
    </Status>
  );
}

function NotReviewable({ document }: { document: DocumentDetail }) {
  const reason = statusReasonText(document.status_reason);
  const noun = documentTypeLabel(document.type).toLowerCase();
  if (document.type === 'offer_letter') {
    return (
      <Status title="Your offer letter is saved">
        <Notice>
          We keep offer letters but do not read them yet. Upload your first pay stub to check it
          here.
        </Notice>
        <BackToDocuments />
      </Status>
    );
  }
  switch (document.status) {
    case 'confirmed':
      if (document.type === 'benefits') {
        return (
          <Status title={BENEFITS_CONFIRMED}>
            <Notice tone="confirmed">
              Your health plan comparison and 401(k) match use what you checked. We deleted the
              file.
            </Notice>
            <ToDecisions label="Continue to decisions" />
          </Status>
        );
      }
      // A newer confirm of the same paycheck counts instead (spec 005 rule 22f).
      if (document.superseded) {
        return (
          <Status title="A newer copy replaced this pay stub">
            <Notice>{SUPERSEDED_TEXT}</Notice>
            <BackToDocuments />
          </Status>
        );
      }
      return (
        <Status title="Your pay stub is confirmed">
          <Notice tone="confirmed">
            Your plan now uses the amounts you checked. We deleted the file.
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
      return <BenefitsUnread document={document} />;
    case 'extracting':
      return (
        <Status title={titleFor(document.type)}>
          <Card gap={12}>
            <div className="flex items-baseline justify-between gap-3 text-small">
              <span className="font-semibold">Reading {noun}</span>
              <span role="status" aria-live="polite" className="text-ink-3">
                Working
              </span>
            </div>
            <Bar label={`Reading ${noun}`} tone="blue" value={0} indeterminate />
            <p className="m-0 text-small text-ink-3">
              We are reading your {noun}. The amounts show here when they are ready.
            </p>
          </Card>
        </Status>
      );
    case 'failed':
      return (
        <Status title={titleFor(document.type)}>
          <Notice tone="warning" title="We could not read this file.">
            {reason ?? 'Upload it again as a PDF, PNG or JPEG.'}
          </Notice>
          <BackToDocuments />
        </Status>
      );
    default:
      return (
        <Status title={titleFor(document.type)}>
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
  const type = query.data?.type;
  return (
    <>
      {/*
       * The page's metadata can only name the step (a pay stub, as the heading
       * reads until the document loads); once its type is known, React's
       * <title> goes ahead of that one in the head. Keyed by type, so a new
       * element is placed whenever the type changes.
       */}
      {type && <title key={type}>{tabTitleFor(type)}</title>}
      <ConfirmContent query={query} />
    </>
  );
}

function ConfirmContent({ query }: { query: ReturnType<typeof useDocument> }) {
  // Kept here: confirming refetches the document as confirmed, which ends the review.
  const [benefitsResult, setBenefitsResult] = useState<Confirmed | null>(null);

  if (benefitsResult) return <BenefitsConfirmed result={benefitsResult} />;
  if (query.isPending) return <Loading />;
  if (query.isError) {
    return (
      <Status title={PAY_STUB_TITLE}>
        <Notice tone="warning" compact role="alert">
          Could not load this document. {apiErrorMessage(query.error, 'Check your connection.')}
        </Notice>
        <BackToDocuments />
      </Status>
    );
  }

  const document = query.data;
  if (document.replaced_by_id) {
    return <Replaced type={document.type} replacedBy={document.replaced_by_id} />;
  }
  if (!isReviewable(document)) return <NotReviewable document={document} />;
  if (!document.proposal) {
    return (
      <Status title={titleFor(document.type)}>
        <Notice tone="warning" compact role="alert">
          This document has nothing to check yet. Try reading it again from your documents.
        </Notice>
        <BackToDocuments />
      </Status>
    );
  }
  if (document.type === 'benefits') {
    const { plans, match_tiers } = document.proposal;
    if (!plans?.length && !match_tiers?.length) return <BenefitsUnread document={document} />;
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
