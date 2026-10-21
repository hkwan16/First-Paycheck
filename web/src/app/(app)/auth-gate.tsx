import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { readSupabaseEnv } from '@/lib/supabase/env';
import { getCurrentUser } from '@/lib/supabase/server';

/**
 * Placeholder guard for the signed-in screens: with Supabase configured, a
 * visitor without a session goes to /sign-in; without it (unit tests, the
 * Playwright smoke run, previews) the screen renders.
 *
 * It reads cookies, so it must sit inside a <Suspense> boundary.
 */
export async function AuthGate({ children }: { children: ReactNode }) {
  if (!readSupabaseEnv()) return children;
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  return children;
}
