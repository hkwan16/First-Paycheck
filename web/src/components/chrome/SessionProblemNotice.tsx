'use client';

import { useId } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { useSessionReadable } from '@/lib/api/session-status';
import { SIGN_OUT_PATH } from '@/lib/auth/sign-out';
import { reloadPage } from '@/lib/navigation';

/**
 * Shown above the screen while the browser cannot read its Supabase session
 * (issue 225): every API request waits on that read, so without it nothing
 * on the page loads. Each request gives up after `SESSION_READ_TIMEOUT_MS`
 * and its card says so; this says why once for the page and offers the two
 * ways out. Reload starts the session afresh in a new page; Sign in again
 * signs this browser out first (`/auth/sign-out`), so a session stuck on a
 * refresh that never answers cannot block signing in either. It goes away
 * when a later read answers.
 */
export function SessionProblemNotice() {
  const titleId = useId();
  if (useSessionReadable()) return null;
  return (
    <Notice
      tone="warning"
      role="alert"
      aria-labelledby={titleId}
      title={<span id={titleId}>We could not check that you are signed in.</span>}
    >
      <div className="flex flex-col gap-3">
        <span>
          Nothing on this page can load until we can. Reload the page to try again, or sign in
          again.
        </span>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={reloadPage}>
            Reload the page
          </Button>
          <form method="post" action={SIGN_OUT_PATH}>
            <Button size="sm" type="submit">
              Sign in again
            </Button>
          </form>
        </div>
      </div>
    </Notice>
  );
}
