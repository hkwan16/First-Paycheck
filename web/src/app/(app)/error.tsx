'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { logErrorOnce } from '@/lib/log-error';

export interface AppErrorProps {
  error: unknown;
  /** Next's retry: fetch and render the segment again. */
  retry: () => void;
}

/**
 * The (app) segment's error boundary (Next's `error.tsx`): a render error that
 * no card boundary caught replaces the page, inside the header and side nav,
 * with what happened, Try again (Next's retry) and a plain link that reloads
 * the page. It also lets `redirect()` and `notFound()` through, which a
 * hand-written boundary here would swallow.
 */
const noSubscription = () => () => undefined;

export default function AppError({ error, retry }: AppErrorProps) {
  useEffect(() => logErrorOnce('[AppError] a page failed to render', error), [error]);
  // The address is read in the browser only; the server has no window (null there).
  const here = useSyncExternalStore(
    noSubscription,
    () => window.location.href,
    () => null,
  );

  return (
    <>
      <PageTitle title="This page could not be shown" />
      <Notice tone="warning" role="alert" className="items-center">
        <div className="flex flex-col gap-3">
          <span>
            Something went wrong while showing this page. Nothing you saved has changed. Try again,
            or reload the page.
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={retry}>
              Try again
            </Button>
            {/* A plain anchor to this same address: a full reload, not a client navigation. */}
            <a href={here ?? undefined} className="font-semibold">
              Reload the page
            </a>
          </div>
        </div>
      </Notice>
    </>
  );
}
