import type { Metadata } from 'next';
import { SignInScreen } from '@/components/screens/sign-in/SignInScreen';

export const metadata: Metadata = { title: 'Sign in' };

/** `?mode=sign-up`, `?next=<path>` and `?error=link` reach the form as a promise. */
export default function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  return <SignInScreen searchParams={searchParams} />;
}
