import type { User } from '@supabase/supabase-js';

export interface AccountSummary {
  /** The user chip's text: the profile name, else the email. */
  label: string;
  /** The account is the shared e2e/demo user, whose data is synthetic. */
  sampleData: boolean;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * What the header shows for a signed-in user. `sampleEmail` is
 * NEXT_PUBLIC_E2E_USER_EMAIL: when the user's email matches it, the header
 * adds a "Sample data" chip.
 */
export function accountSummary(
  user: Pick<User, 'email' | 'user_metadata'>,
  sampleEmail?: string,
): AccountSummary {
  const metadata = user.user_metadata ?? {};
  const email = text(user.email);
  const label = text(metadata.full_name) || text(metadata.name) || email || 'Account';
  const sample = text(sampleEmail).toLowerCase();
  return { label, sampleData: sample !== '' && email.toLowerCase() === sample };
}
