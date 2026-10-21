import { Chip } from '@/components/ui/Chip';
import { accountSummary } from '@/lib/auth/account';
import { getCurrentUser } from '@/lib/supabase/server';
import { UserMenu } from './UserMenu';

/**
 * The header's account chips, read from the verified Supabase user on the
 * server: "Sample data" for the e2e account (NEXT_PUBLIC_E2E_USER_EMAIL), then
 * the user menu labeled with the person's name or email. It reads cookies, so
 * the (app) layout renders it inside Suspense.
 */
export async function HeaderAccount() {
  const user = await getCurrentUser();
  if (!user) return null;
  const { label, sampleData } = accountSummary(user, process.env.NEXT_PUBLIC_E2E_USER_EMAIL);
  return (
    <>
      {sampleData && <Chip>Sample data</Chip>}
      <UserMenu label={label} />
    </>
  );
}
