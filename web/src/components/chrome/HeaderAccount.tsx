import { getCurrentUser } from '@/lib/supabase/server';
import { UserMenu } from './UserMenu';

/**
 * The header's account chips, read from the verified Supabase user on the
 * server. It reads cookies, so the (app) layout renders it inside Suspense.
 */
export async function HeaderAccount() {
  const user = await getCurrentUser();
  if (!user) return null;
  return <UserMenu label={user.email ?? 'Account'} />;
}
