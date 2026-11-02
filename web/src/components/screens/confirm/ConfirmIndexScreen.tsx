'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PageTitle } from '@/components/chrome/PageTitle';
import { ArrowRightIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorMessage } from '@/lib/api/errors';
import { newestReviewable, useDocuments, usePayStubs } from '@/lib/api/hooks';
import { confirmRoute } from '@/lib/routes';

const TITLE = 'Check what we read from your pay stub';

/**
 * `/setup/confirm` without a document (the side nav's Confirm step): goes to
 * the newest pay stub waiting for review or manual entry; otherwise, once
 * both lists have loaded (issue 196), says the pay stub is confirmed and what
 * comes next, or that there is none yet and where to add one. Neither of
 * those is titled as a review: there is nothing to check (issue 209).
 */
export function ConfirmIndexScreen() {
  const router = useRouter();
  const documents = useDocuments();
  const payStubs = usePayStubs();
  const target = newestReviewable(documents.data);

  useEffect(() => {
    if (target) router.replace(confirmRoute(target.id));
  }, [target, router]);

  const failed = documents.error ?? payStubs.error;
  if (failed) {
    return (
      <>
        <PageTitle title={TITLE} />
        <Notice tone="warning" compact role="alert">
          Could not load your documents. {apiErrorMessage(failed, 'Check your connection.')}
        </Notice>
      </>
    );
  }

  if (documents.isPending || target || payStubs.isPending) {
    return (
      <>
        <PageTitle title={TITLE} />
        <Card aria-busy="true" gap={12}>
          <span className="sr-only">Finding your pay stub</span>
          <Skeleton className="w-48" />
          <Skeleton className="w-64 text-small" />
        </Card>
      </>
    );
  }

  if ((payStubs.data?.length ?? 0) > 0) {
    return (
      <>
        <PageTitle title="Your pay stub is confirmed" />
        <Notice tone="confirmed">
          Your plan uses the amounts you checked. When your pay changes, add your newest pay stub on
          the first step.
        </Notice>
        <div>
          <Button href="/setup/spending" variant="primary">
            Continue to spending
            <ArrowRightIcon />
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageTitle title="No pay stub to check yet" />
      <Card gap={12}>
        <p className="m-0">
          Add your latest pay stub on the first step. We read it and show you each amount to check
          here.
        </p>
        <div>
          <Button href="/setup/link" variant="primary">
            Add a pay stub
            <ArrowRightIcon />
          </Button>
        </div>
      </Card>
    </>
  );
}
