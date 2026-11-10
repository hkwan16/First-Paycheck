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

import { buttonClasses } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { UserMenu } from './UserMenu';

/** A full-width Button's classes in a variant, as Button merges them (issue 205). */
const blockButton = (variant: 'default' | 'destructive') =>
  cn(buttonClasses({ variant, block: true }));

const LABEL = 'alex@example.com';

function setup() {
  const rendered = renderWithProviders(
    <>
      <UserMenu label={LABEL} />
      <p>Elsewhere on the page</p>
    </>,
  );
  return { ...rendered, trigger: screen.getByRole('button', { name: LABEL }) };
}

const item = (name: string) => screen.getByRole('menuitem', { name });

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

describe('UserMenu, the account menu (issue 242)', () => {
  it('is a chip-styled menu button, closed at first', () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveClass('rounded-full', 'bg-fill', 'text-tiny');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a menu named for the account and focuses its first item', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: LABEL });
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((element) => element.textContent),
    ).toEqual(['Sign out', 'Delete account']);
    expect(item('Sign out')).toHaveFocus();
  });

  it('sets deleting the account apart from signing out (issue 205)', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    const separator = within(screen.getByRole('menu')).getByRole('separator');
    // Sign out, then a rule, then the destructive action.
    expect(item('Sign out').compareDocumentPosition(separator)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(separator.compareDocumentPosition(item('Delete account'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(item('Delete account').className).toBe(blockButton('destructive'));
    expect(item('Sign out').className).toBe(blockButton('default'));
  });

  it('moves between items with the arrow keys, Home and End, and wraps', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.keyboard('{ArrowDown}');
    expect(item('Delete account')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(item('Sign out')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(item('Delete account')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(item('Sign out')).toHaveFocus();
    await user.keyboard('{End}');
    expect(item('Delete account')).toHaveFocus();
  });

  it('keeps the items out of the Tab order, so the menu is one stop', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    for (const element of screen.getAllByRole('menuitem')) {
      expect(element).toHaveAttribute('tabindex', '-1');
    }
  });

  it('opens from the keyboard: Enter or ArrowDown at the first item, ArrowUp at the last', async () => {
    const { user, trigger } = setup();
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(item('Sign out')).toHaveFocus();
    await user.keyboard('{Escape}');

    await user.keyboard('{ArrowDown}');
    expect(item('Sign out')).toHaveFocus();
    await user.keyboard('{Escape}');

    await user.keyboard('{ArrowUp}');
    expect(item('Delete account')).toHaveFocus();
  });

  it('closes on Escape and returns focus to the chip', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes when Tab moves focus on', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes when the person clicks elsewhere', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(screen.getByText('Elsewhere on the page'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('UserMenu, signing out (issue 224)', () => {
  it('posts to the sign-out route, a full navigation, and drops every cached read first', async () => {
    const { user, trigger, queryClient } = setup();
    queryClient.setQueryData(['get', '/accounts'], { items: [{ id: 'chase' }] });
    await user.click(trigger);
    const signOut = item('Sign out') as HTMLButtonElement;
    expect(signOut).toHaveAttribute('type', 'submit');
    const form = signOut.form!;
    expect(form.method).toBe('post');
    expect(new URL(form.action).pathname).toBe('/auth/sign-out');

    // jsdom cannot navigate; the browser would leave the page on this submit.
    let submitted = 0;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted += 1;
    });
    await user.click(signOut);

    expect(submitted).toBe(1);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    // Busy while the page unloads; a second click sends nothing more.
    expect(signOut).toHaveAttribute('aria-busy', 'true');
    await user.click(signOut);
    expect(submitted).toBe(1);
    expect(mocks.auth.signOut).not.toHaveBeenCalled();
  });
});

describe('UserMenu, deleting the account (issue 242)', () => {
  /** Opens the menu and the confirmation dialog. */
  async function confirmation() {
    const context = setup();
    await context.user.click(context.trigger);
    await context.user.click(item('Delete account'));
    const dialog = screen.getByRole('dialog', { name: 'Delete your account?' });
    return { ...context, dialog };
  }

  function deletes() {
    const paths: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'DELETE') paths.push(new URL(request.url).pathname);
    });
    return paths;
  }

  it('asks in a modal dialog that says what goes, closing the menu and focusing the field', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { dialog } = await confirmation();
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog).toHaveAttribute('open');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(dialog).toHaveTextContent(
      'This deletes your account and everything in it: linked banks, transactions, documents, decisions, goals and check-ins. It cannot be undone.',
    );
    expect(within(dialog).getByRole('textbox', { name: 'Type delete to confirm' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Delete my account' })).toBeDisabled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('deletes only once the word delete is typed, then signs out and says so on sign in', async () => {
    const paths = deletes();
    const { user, dialog } = await confirmation();
    const field = within(dialog).getByRole('textbox', { name: 'Type delete to confirm' });
    const button = within(dialog).getByRole('button', { name: 'Delete my account' });

    await user.type(field, 'delet');
    expect(button).toBeDisabled();
    await user.type(field, 'e');
    expect(button).toBeEnabled();
    // The last step is drawn as the destructive action, never as the blue primary.
    expect(button.className).toBe(blockButton('destructive'));
    await user.click(button);

    await waitFor(() =>
      expect(mocks.hardNavigate).toHaveBeenCalledExactlyOnceWith('/sign-in?deleted=1'),
    );
    expect(paths).toEqual(['/me']);
    expect(db.accounts).toEqual([]);
    expect(mocks.auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    // Busy while the page unloads, and Escape cannot close it under the request.
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.keyboard('{Escape}');
    expect(dialog).toHaveAttribute('open');
  });

  it('accepts the word typed with capitals or spaces, and submits with Enter', async () => {
    const paths = deletes();
    const { user, dialog } = await confirmation();
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Type delete to confirm' }),
      '  DELETE {Enter}',
    );
    await waitFor(() => expect(paths).toEqual(['/me']));
  });

  it('does nothing on Enter before the word is typed', async () => {
    const paths = deletes();
    const { user, dialog } = await confirmation();
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Type delete to confirm' }),
      'remove{Enter}',
    );
    expect(paths).toEqual([]);
  });

  it('keeps the account on Keep my account and gives focus back to the chip', async () => {
    const paths = deletes();
    const { user, dialog, trigger } = await confirmation();
    await user.click(within(dialog).getByRole('button', { name: 'Keep my account' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(paths).toEqual([]);
  });

  it('closes on Escape, keeps the account and gives focus back to the chip', async () => {
    const paths = deletes();
    const { user, trigger } = await confirmation();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
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
    const { user, dialog } = await confirmation();
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Type delete to confirm' }),
      'delete',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete my account' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Your account was not deleted. Database is busy',
    );
    expect(mocks.auth.signOut).not.toHaveBeenCalled();
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });

  it('starts over when it is closed and opened again', async () => {
    const { user, trigger, dialog } = await confirmation();
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Type delete to confirm' }),
      'delete',
    );
    await user.keyboard('{Escape}');
    await user.click(trigger);
    await user.click(item('Delete account'));
    expect(screen.getByRole('textbox', { name: 'Type delete to confirm' })).toHaveValue('');
  });
});
