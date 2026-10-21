import { redirect } from 'next/navigation';

/** Placeholder: until the auth guard lands, the root sends everyone to sign in. */
export default function Home() {
  redirect('/sign-in');
}
