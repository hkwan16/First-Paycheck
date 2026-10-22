'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { PlusCircleIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FieldError } from '@/components/ui/FieldError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Notice } from '@/components/ui/Notice';
import { authErrorMessage } from '@/lib/auth/errors';
import { authCallbackUrl } from '@/lib/auth/next-path';
import { validateEmail, validatePassword } from '@/lib/auth/validation';
import { hardNavigate } from '@/lib/navigation';
import { signInRoute, type AuthMode } from '@/lib/routes';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';

export interface AuthFormProps {
  mode: AuthMode;
  /** A validated relative path to return to after signing in, or null for home. */
  next: string | null;
  /** An email link failed (`/sign-in?error=link`, set by /auth/callback). */
  linkError: boolean;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; action: 'password' | 'link' }
  | { kind: 'error'; message: string }
  | { kind: 'sent'; message: ReactNode };

const COPY = {
  'sign-in': {
    title: 'Sign in',
    submit: 'Sign in',
    passwordAutoComplete: 'current-password',
  },
  'sign-up': {
    title: 'Create an account',
    submit: 'Create account',
    passwordAutoComplete: 'new-password',
  },
} as const;

const LINK_ERROR =
  'That sign-in link is invalid or has expired. Email yourself a new one, or sign in with your password.';
const NOT_CONFIGURED =
  'Sign-in is not set up in this environment: the Supabase URL and key are missing.';

/**
 * The sign-in card of the mockup's screen 0 (Main.dc.html), wired to Supabase
 * Auth: password sign-in, account creation (`mode`), and a magic link. Fields
 * validate when left and then live as they are fixed; every submit validates
 * all of them. Success is a full navigation (see `hardNavigate`).
 */
export function AuthForm({ mode, next, linkError }: AuthFormProps) {
  const copy = COPY[mode];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState({ email: false, password: false });
  const [status, setStatus] = useState<Status>(
    linkError ? { kind: 'error', message: LINK_ERROR } : { kind: 'idle' },
  );
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const emailError = touched.email ? validateEmail(email) : null;
  const passwordError = touched.password ? validatePassword(password, mode) : null;
  const busy = status.kind === 'busy';
  const destination = next ?? '/';

  /** Run one Supabase call; a thrown error (fetch rejected) reads as a network failure. */
  async function attempt(action: 'password' | 'link', run: () => Promise<Status | 'navigate'>) {
    setStatus({ kind: 'busy', action });
    let result: Status | 'navigate';
    try {
      result = await run();
    } catch (error) {
      result = { kind: 'error', message: authErrorMessage(error) };
    }
    if (result === 'navigate') {
      hardNavigate(destination);
      return; // Stay busy while the page unloads.
    }
    setStatus(result);
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setTouched({ email: true, password: true });
    if (validateEmail(email)) return emailRef.current?.focus();
    if (validatePassword(password, mode)) return passwordRef.current?.focus();

    const supabase = getSupabaseBrowserClient();
    if (!supabase) return setStatus({ kind: 'error', message: NOT_CONFIGURED });
    const credentials = { email: email.trim(), password };

    void attempt('password', async () => {
      if (mode === 'sign-in') {
        const { error } = await supabase.auth.signInWithPassword(credentials);
        return error ? { kind: 'error', message: authErrorMessage(error) } : 'navigate';
      }
      const { data, error } = await supabase.auth.signUp({
        ...credentials,
        options: { emailRedirectTo: authCallbackUrl(window.location.origin, next) },
      });
      if (error) return { kind: 'error', message: authErrorMessage(error) };
      // With email confirmation on, Supabase creates the user without a session.
      if (data.session) return 'navigate';
      return {
        kind: 'sent',
        message: (
          <>
            We sent a confirmation link to {credentials.email}. Open it in this browser to finish
            creating your account.
          </>
        ),
      };
    });
  };

  const onEmailLink = () => {
    if (busy) return;
    setTouched((t) => ({ ...t, email: true }));
    if (validateEmail(email)) return emailRef.current?.focus();

    const supabase = getSupabaseBrowserClient();
    if (!supabase) return setStatus({ kind: 'error', message: NOT_CONFIGURED });
    const address = email.trim();

    void attempt('link', async () => {
      const { error } = await supabase.auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo: authCallbackUrl(window.location.origin, next) },
      });
      if (error) return { kind: 'error', message: authErrorMessage(error) };
      return {
        kind: 'sent',
        message: (
          <>We sent a sign-in link to {address}. Open it in this browser to finish signing in.</>
        ),
      };
    });
  };

  return (
    <Card as="form" padding={24} aria-labelledby="signin-title" noValidate onSubmit={onSubmit}>
      <h2 id="signin-title" className="m-0 text-headline tracking-[-0.012em]">
        {copy.title}
      </h2>
      {status.kind === 'error' && (
        <Notice tone="warning" role="alert">
          {status.message}
        </Notice>
      )}
      {status.kind === 'sent' && (
        <Notice tone="confirmed" role="status" title="Check your email.">
          {status.message}
        </Notice>
      )}
      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          ref={emailRef}
          id="email"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))}
          invalid={emailError !== null}
          aria-describedby={emailError ? 'email-error' : undefined}
        />
        <FieldError id="email-error">{emailError}</FieldError>
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          ref={passwordRef}
          id="password"
          type="password"
          name="password"
          autoComplete={copy.passwordAutoComplete}
          placeholder="At least 12 characters"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, password: true }))}
          invalid={passwordError !== null}
          aria-describedby={passwordError ? 'password-error' : undefined}
        />
        <FieldError id="password-error">{passwordError}</FieldError>
      </div>
      <Button
        type="submit"
        variant="primary"
        block
        loading={busy && status.action === 'password'}
        disabled={busy && status.action !== 'password'}
      >
        {copy.submit}
      </Button>
      <div className="flex items-center gap-3 text-tiny leading-[1.5] tracking-[0.04em] text-ink-3 uppercase before:h-px before:flex-1 before:bg-ink/10 after:h-px after:flex-1 after:bg-ink/10">
        or
      </div>
      <Button
        block
        onClick={onEmailLink}
        loading={busy && status.action === 'link'}
        disabled={busy && status.action !== 'link'}
      >
        <PlusCircleIcon className="text-ink" />
        Email me a sign-in link
      </Button>
      <p className="mt-1 mb-0 text-small text-ink-3">
        Secured by Supabase Auth. Your bank login never passes through First Paycheck; Plaid handles
        it on the next step.{' '}
        {mode === 'sign-in' ? (
          <Link href={signInRoute({ mode: 'sign-up', next })}>Create an account</Link>
        ) : (
          <>
            Already have an account? <Link href={signInRoute({ next })}>Sign in</Link>
          </>
        )}
      </p>
    </Card>
  );
}
