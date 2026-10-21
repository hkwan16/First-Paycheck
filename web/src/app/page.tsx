import { redirect } from 'next/navigation';

// This page only redirects, so it has nothing to render instantly; opt it out
// of Cache Components' instant-navigation validation.
export const instant = false;

/** Placeholder: until the auth guard decides, the root sends everyone to sign in. */
export default function Home() {
  redirect('/sign-in');
}
