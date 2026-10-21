import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { REQUEST_PATH_HEADER } from '@/lib/auth/next-path';
import { signInRoute } from '@/lib/routes';
import { readSupabaseEnv } from '@/lib/supabase/env';
import { getCurrentUser } from '@/lib/supabase/server';

/**
 * Guard for the signed-in screens: a visitor without a verified Supabase user
 * goes to /sign-in?next=<the path they asked for> (the proxy forwards it; a
 * layout cannot read the URL). Without Supabase configured (unit tests, the
 * Playwright smoke run in CI, previews without secrets) the screen renders.
 *
 * It reads cookies and headers, so it must sit inside a <Suspense> boundary.
 */
export async function AuthGate({ children }: { children: ReactNode }) {
  if (!readSupabaseEnv()) return children;
  const user = await getCurrentUser();
  if (!user) {
    const next = (await headers()).get(REQUEST_PATH_HEADER);
    redirect(signInRoute({ next }));
  }
  return children;
}
