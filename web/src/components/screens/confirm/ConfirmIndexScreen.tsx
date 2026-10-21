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
 * the newest pay stub waiting for review or manual entry, or says there is
 * none and where to add one.
 */
export function ConfirmIndexScreen() {
  const router = useRouter();
  const documents = useDocuments();
  const payStubs = usePayStubs();
  const target = newestReviewable(documents.data);

  useEffect(() => {
    if (target) router.replace(confirmRoute(target.id));
  }, [target, router]);

  if (documents.isError) {
    return (
      <>
        <PageTitle title={TITLE} />
        <Notice tone="warning" compact role="alert">
          Could not load your documents.{' '}
          {apiErrorMessage(documents.error, 'Check your connection.')}
        </Notice>
      </>
    );
  }

  if (documents.isPending || target) {
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
        <PageTitle title={TITLE} />
        <Notice tone="confirmed" title="Your pay stub is confirmed.">
          Calculators read the values you checked. Upload a newer pay stub on the first step when
          your pay changes.
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
      <PageTitle title={TITLE} />
      <Card gap={12}>
        <p className="m-0">
          No pay stub is waiting for review. Upload your latest pay stub and it is read here, field
          by field, before anything uses it.
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
