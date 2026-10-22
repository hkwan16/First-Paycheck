import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';

const mocks = vi.hoisted(() => {
  const auth = { signOut: vi.fn(), getSession: vi.fn(), refreshSession: vi.fn() };
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
  const { user } = renderWithProviders(
    <>
      <UserMenu label={LABEL} />
      <p>Elsewhere on the page</p>
    </>,
  );
  return { user, trigger: screen.getByRole('button', { name: LABEL }) };
}

beforeEach(() => {
  mocks.auth.signOut.mockResolvedValue({ error: null });
  mocks.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'access-1' } },
    error: null,
  });
});
afterEach(() => {
  vi.clearAllMocks();
  server.events.removeAllListeners();
});

describe('UserMenu', () => {
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

describe('UserMenu, deleting the account', () => {
  /** Opens the menu and the in-page confirmation. */
  async function confirmation() {
    const context = setup();
    await context.user.click(context.trigger);
    await context.user.click(screen.getByRole('button', { name: 'Delete account' }));
    const group = screen.getByRole('group', { name: 'Delete your account?' });
    return { ...context, group };
  }

  function deletes() {
    const paths: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'DELETE') paths.push(new URL(request.url).pathname);
    });
    return paths;
  }

  it('asks in the page, says what goes, and focuses the confirmation field', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { group } = await confirmation();
    expect(group).toHaveTextContent(
      'This deletes your account and everything in it: linked banks, transactions, documents, decisions, goals and check-ins. It cannot be undone.',
    );
    expect(within(group).getByRole('textbox', { name: 'Type delete to confirm' })).toHaveFocus();
    expect(within(group).getByRole('button', { name: 'Delete my account' })).toBeDisabled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('deletes only once the word delete is typed, then signs out and says so on sign in', async () => {
    const paths = deletes();
    const { user, group } = await confirmation();
    const field = within(group).getByRole('textbox', { name: 'Type delete to confirm' });
    const button = within(group).getByRole('button', { name: 'Delete my account' });

    await user.type(field, 'delet');
    expect(button).toBeDisabled();
    await user.type(field, 'e');
    expect(button).toBeEnabled();
    await user.click(button);

    await waitFor(() =>
      expect(mocks.hardNavigate).toHaveBeenCalledExactlyOnceWith('/sign-in?deleted=1'),
    );
    expect(paths).toEqual(['/me']);
    expect(db.accounts).toEqual([]);
    expect(mocks.auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    // Busy while the page unloads.
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('accepts the word typed with capitals or spaces, and submits with Enter', async () => {
    const paths = deletes();
    const { user, group } = await confirmation();
    await user.type(
      within(group).getByRole('textbox', { name: 'Type delete to confirm' }),
      '  DELETE {Enter}',
    );
    await waitFor(() => expect(paths).toEqual(['/me']));
  });

  it('does nothing on Enter before the word is typed', async () => {
    const paths = deletes();
    const { user, group } = await confirmation();
    await user.type(
      within(group).getByRole('textbox', { name: 'Type delete to confirm' }),
      'remove{Enter}',
    );
    expect(paths).toEqual([]);
  });

  it('keeps the account on Keep my account and returns focus to Delete account', async () => {
    const paths = deletes();
    const { user, group } = await confirmation();
    await user.click(within(group).getByRole('button', { name: 'Keep my account' }));
    expect(screen.queryByRole('group', { name: 'Delete your account?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete account' })).toHaveFocus();
    expect(paths).toEqual([]);
  });

  it('says why the delete failed and keeps the person signed in', async () => {
    server.use(
      http.delete(apiUrl('/me'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Database is busy' } },
          { status: 500 },
        ),
      ),
    );
    const { user, group } = await confirmation();
    await user.type(
      within(group).getByRole('textbox', { name: 'Type delete to confirm' }),
      'delete',
    );
    await user.click(within(group).getByRole('button', { name: 'Delete my account' }));
    expect(await within(group).findByRole('alert')).toHaveTextContent(
      'Your account was not deleted. Database is busy',
    );
    expect(mocks.auth.signOut).not.toHaveBeenCalled();
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });

  it('starts over when the menu is closed and opened again', async () => {
    const { user, trigger, group } = await confirmation();
    await user.type(
      within(group).getByRole('textbox', { name: 'Type delete to confirm' }),
      'delete',
    );
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(screen.queryByRole('group', { name: 'Delete your account?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeInTheDocument();
  });
});
