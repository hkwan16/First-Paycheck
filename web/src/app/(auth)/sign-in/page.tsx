import type { Metadata } from 'next';
import { SignInScreen } from '@/components/screens/sign-in/SignInScreen';
import { parseSignInParams } from '@/components/screens/sign-in/sign-in-params';
import { HydrationMarker } from '@/app/hydration-marker';

export const metadata: Metadata = { title: 'Sign in' };

// The form depends on the query (?mode=sign-up, ?next=, ?error=link), so the
// page renders in one piece at request time. A Suspense fallback form would be
// interactive and then replaced when the real one streamed in, dropping
// whatever the person had already typed.
export const instant = false;

export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  return (
    <>
      <SignInScreen {...parseSignInParams(await searchParams)} />
      <HydrationMarker />
    </>
  );
}
