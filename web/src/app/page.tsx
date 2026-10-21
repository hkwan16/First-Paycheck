import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/supabase/server';

// This page only redirects, so there is no shell to prerender: opting out of
// Cache Components' instant validation lets it read the session at the top
// level and answer with a real 307 instead of a streamed client redirect.
export const instant = false;

/** The root sends a signed-in person to the first setup step and everyone else to sign in. */
export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? '/setup/link' : '/sign-in');
}
