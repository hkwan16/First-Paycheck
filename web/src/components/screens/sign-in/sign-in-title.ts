import type { AuthMode } from '@/lib/routes';

/**
 * The form's heading and the browser tab's title, one per mode, so they never
 * disagree (issue 271: /sign-in?mode=sign-up said "Create an account" in the
 * form and "Sign in" in the tab). Plain module: `AuthForm` is a client
 * component, and a server page importing a value from one gets a reference,
 * not the value.
 */
export const SIGN_IN_TITLE: Record<AuthMode, string> = {
  'sign-in': 'Sign in',
  'sign-up': 'Create an account',
};
