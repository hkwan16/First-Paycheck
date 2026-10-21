import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toneSoft } from '@/lib/design/tone';
import { render, screen, userEvent, waitFor } from '@/test/render';

const mocks = vi.hoisted(() => {
  const auth = {
    signInWithPassword: vi.fn(),
    signInWithOtp: vi.fn(),
    signUp: vi.fn(),
  };
  return {
    auth,
    getSupabaseBrowserClient: vi.fn((): { auth: typeof auth } | null => ({ auth })),
    hardNavigate: vi.fn(),
  };
});
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseBrowserClient: mocks.getSupabaseBrowserClient,
}));
vi.mock('@/lib/navigation', () => ({ hardNavigate: mocks.hardNavigate }));

import { AuthForm, type AuthFormProps } from './AuthForm';

const EMAIL = 'alex@example.com';
const PASSWORD = 'correct horse battery';

function setup(props: Partial<AuthFormProps> = {}) {
  const user = userEvent.setup();
  render(<AuthForm mode="sign-in" next={null} linkError={false} {...props} />);
  return {
    user,
    email: screen.getByLabelText('Email'),
    password: screen.getByLabelText('Password'),
  };
}

const session = { access_token: 'jwt', refresh_token: 'r', user: { id: 'u1' } };

/** A promise the test resolves by hand, to observe the pending state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('AuthForm, sign in', () => {
  beforeEach(() => {
    mocks.auth.signInWithPassword.mockResolvedValue({ data: { session }, error: null });
    mocks.auth.signInWithOtp.mockResolvedValue({ data: {}, error: null });
  });

  it('keeps the mockup copy and autocomplete hints', () => {
    setup();
    expect(screen.getByRole('form', { name: 'Sign in' })).toHaveClass('rounded-card');
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'placeholder',
      'At least 12 characters',
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/sign-in?mode=sign-up',
    );
  });

  it('carries the return path into the create-account link', () => {
    setup({ next: '/setup/link' });
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/sign-in?mode=sign-up&next=/setup/link',
    );
  });

  it('validates a field when the person leaves it, then live as they fix it', async () => {
    const { user, email } = setup();
    await user.type(email, 'alex@');
    expect(screen.queryByText('Enter an email address like you@example.com.')).toBeNull();

    await user.tab();
    const message = screen.getByText('Enter an email address like you@example.com.');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAttribute('aria-describedby', message.id);

    await user.type(email, 'example.com');
    expect(screen.queryByText('Enter an email address like you@example.com.')).toBeNull();
    expect(email).not.toHaveAttribute('aria-invalid');
  });

  it('shows every problem on submit, focuses the first, and does not call Supabase', async () => {
    const { user, email } = setup();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(email).toHaveFocus();
    expect(mocks.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('signs in with the trimmed email, shows progress, and goes home', async () => {
    const pending = deferred<{ data: { session: typeof session }; error: null }>();
    mocks.auth.signInWithPassword.mockReturnValueOnce(pending.promise);
    const { user, email, password } = setup();
    await user.type(email, `  ${EMAIL} `);
    await user.type(password, PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(mocks.auth.signInWithPassword).toHaveBeenCalledExactlyOnceWith({
      email: EMAIL,
      password: PASSWORD,
    });
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeDisabled();

    pending.resolve({ data: { session }, error: null });
    await waitFor(() => expect(mocks.hardNavigate).toHaveBeenCalledExactlyOnceWith('/'));
    // The page is leaving; the button stays busy rather than flashing back.
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('aria-busy', 'true');
  });

  it('returns to the next path after signing in', async () => {
    const { user, email, password } = setup({ next: '/setup/link' });
    await user.type(email, EMAIL);
    await user.type(password, PASSWORD);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mocks.hardNavigate).toHaveBeenCalledWith('/setup/link'));
  });

  it('shows a warning notice for a wrong password and lets the person retry', async () => {
    mocks.auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null },
      error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
    });
    const { user, email, password } = setup();
    await user.type(email, EMAIL);
    await user.type(password, 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'That email and password do not match. Check them and try again, or email yourself a sign-in link.',
    );
    expect(alert).toHaveClass(...toneSoft.warning.split(' '));
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toHaveAttribute('aria-busy');
    expect(mocks.hardNavigate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(mocks.hardNavigate).toHaveBeenCalledWith('/'));
  });

  it('explains a network failure, whether Supabase reports it or fetch throws', async () => {
    mocks.auth.signInWithPassword
      .mockResolvedValueOnce({
        data: { session: null },
        error: new AuthRetryableFetchError('Failed to fetch', 0),
      })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { user, email, password } = setup();
    await user.type(email, EMAIL);
    await user.type(password, PASSWORD);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'We could not reach the sign-in service. Check your connection and try again.',
      );
    }
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });

  it('emails a sign-in link that returns through /auth/callback, without needing a password', async () => {
    const { user, email } = setup({ next: '/plan' });
    await user.type(email, EMAIL);
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));

    expect(mocks.auth.signInWithOtp).toHaveBeenCalledExactlyOnceWith({
      email: EMAIL,
      options: { emailRedirectTo: 'http://localhost:3000/auth/callback?next=%2Fplan' },
    });
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(
      `Check your email. We sent a sign-in link to ${EMAIL}. Open it in this browser to finish signing in.`,
    );
    expect(status).toHaveClass(...toneSoft.confirmed.split(' '));
    expect(screen.queryByText('Enter your password.')).toBeNull();
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });

  it('checks the email before sending a link', async () => {
    const { user, email } = setup();
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(email).toHaveFocus();
    expect(mocks.auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it('reports a failed link request', async () => {
    mocks.auth.signInWithOtp.mockResolvedValueOnce({
      data: {},
      error: new AuthApiError('rate limit', 429, 'over_email_send_rate_limit'),
    });
    const { user, email } = setup();
    await user.type(email, EMAIL);
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Wait a minute, then try again.',
    );
  });

  it('opens with a warning when an email link failed', () => {
    setup({ linkError: true });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That sign-in link is invalid or has expired. Email yourself a new one, or sign in with your password.',
    );
  });

  it('says so when Supabase is not configured instead of failing silently', async () => {
    mocks.getSupabaseBrowserClient.mockReturnValueOnce(null);
    const { user, email, password } = setup();
    await user.type(email, EMAIL);
    await user.type(password, PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in is not set up in this environment: the Supabase URL and key are missing.',
    );
  });
});

describe('AuthForm, create an account', () => {
  beforeEach(() => {
    mocks.auth.signUp.mockResolvedValue({ data: { user: { id: 'u1' }, session }, error: null });
  });

  it('switches the heading, button, password hint and footer link', () => {
    setup({ mode: 'sign-up', next: '/plan' });
    expect(screen.getByRole('form', { name: 'Create an account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByRole('button', { name: 'Create account' })).toHaveAttribute(
      'type',
      'submit',
    );
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/sign-in?next=/plan',
    );
  });

  it('asks for at least 12 characters as soon as the password field is left', async () => {
    const { user, password } = setup({ mode: 'sign-up' });
    await user.type(password, 'short');
    await user.tab();
    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(password).toHaveAttribute('aria-invalid', 'true');
  });

  it('signs straight in when Supabase returns a session', async () => {
    const { user, email, password } = setup({ mode: 'sign-up', next: '/setup/link' });
    await user.type(email, EMAIL);
    await user.type(password, PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(mocks.auth.signUp).toHaveBeenCalledExactlyOnceWith({
      email: EMAIL,
      password: PASSWORD,
      options: { emailRedirectTo: 'http://localhost:3000/auth/callback?next=%2Fsetup%2Flink' },
    });
    await waitFor(() => expect(mocks.hardNavigate).toHaveBeenCalledWith('/setup/link'));
  });

  it('asks the person to confirm their email when there is no session yet', async () => {
    mocks.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'u1' }, session: null },
      error: null,
    });
    const { user, email, password } = setup({ mode: 'sign-up' });
    await user.type(email, EMAIL);
    await user.type(password, PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      `Check your email. We sent a confirmation link to ${EMAIL}. Open it in this browser to finish creating your account.`,
    );
    expect(screen.getByRole('button', { name: 'Create account' })).not.toHaveAttribute('aria-busy');
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });

  it('shows a sign-up error in the warning notice', async () => {
    mocks.auth.signUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new AuthApiError('User already registered', 422, 'user_already_exists'),
    });
    const { user, email, password } = setup({ mode: 'sign-up' });
    await user.type(email, EMAIL);
    await user.type(password, PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account with this email already exists. Sign in instead.',
    );
  });
});
