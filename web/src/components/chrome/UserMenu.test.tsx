import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, userEvent, waitFor } from '@/test/render';

const mocks = vi.hoisted(() => {
  const auth = { signOut: vi.fn() };
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

import { UserMenu } from './UserMenu';

const LABEL = 'alex@example.com';

function setup() {
  const user = userEvent.setup();
  render(
    <>
      <UserMenu label={LABEL} />
      <p>Elsewhere on the page</p>
    </>,
  );
  return { user, trigger: screen.getByRole('button', { name: LABEL }) };
}

describe('UserMenu', () => {
  beforeEach(() => {
    mocks.auth.signOut.mockResolvedValue({ error: null });
  });

  it('is a chip-styled disclosure button, closed at first', () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveClass('rounded-full', 'bg-fill', 'text-tiny');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('opens a panel with the sign-out action', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
    expect(panel).toContainElement(screen.getByRole('button', { name: 'Sign out' }));
  });

  it('closes on Escape and returns focus to the chip', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes when the person clicks elsewhere', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(screen.getByText('Elsewhere on the page'));
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('signs out of this browser only, then goes to sign in', async () => {
    let finish!: (value: { error: null }) => void;
    mocks.auth.signOut.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(mocks.auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveAttribute('aria-busy', 'true');
    finish({ error: null });
    await waitFor(() => expect(mocks.hardNavigate).toHaveBeenCalledExactlyOnceWith('/sign-in'));
  });

  it('keeps the person signed in and says why when sign-out fails', async () => {
    mocks.auth.signOut.mockResolvedValueOnce({
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    });
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not sign you out. Check your connection and try again.',
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).not.toHaveAttribute('aria-busy');
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });

  it('goes straight to sign in when Supabase is not configured', async () => {
    mocks.getSupabaseBrowserClient.mockReturnValueOnce(null);
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mocks.hardNavigate).toHaveBeenCalledWith('/sign-in');
  });
});
