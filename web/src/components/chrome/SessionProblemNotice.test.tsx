import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionStatus } from '@/lib/api/session-status';
import { renderWithProviders, screen, within } from '@/test/render';

const mocks = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ reloadPage: mocks.reloadPage }));

import { SessionProblemNotice } from './SessionProblemNotice';

afterEach(() => {
  act(() => sessionStatus.report(true));
  vi.clearAllMocks();
});

const NAME = 'We could not check that you are signed in.';

describe('SessionProblemNotice (issue 225)', () => {
  it('shows nothing while the session reads fine', () => {
    const { container } = renderWithProviders(<SessionProblemNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says why nothing loads, with a reload and a clean sign-in, once a read times out', async () => {
    const { user } = renderWithProviders(<SessionProblemNotice />);
    act(() => sessionStatus.report(false));

    const notice = screen.getByRole('alert', { name: NAME });
    expect(notice).toHaveTextContent('Nothing on this page can load until we can.');
    await user.click(within(notice).getByRole('button', { name: 'Reload the page' }));
    expect(mocks.reloadPage).toHaveBeenCalledOnce();

    // Sign in again first signs this browser out, so the stuck session goes too.
    const signIn = within(notice).getByRole('button', {
      name: 'Sign in again',
    }) as HTMLButtonElement;
    expect(signIn).toHaveAttribute('type', 'submit');
    expect(signIn.form?.method).toBe('post');
    expect(new URL(signIn.form!.action).pathname).toBe('/auth/sign-out');
  });

  it('goes away once a later read answers', () => {
    renderWithProviders(<SessionProblemNotice />);
    act(() => sessionStatus.report(false));
    expect(screen.getByRole('alert', { name: NAME })).toBeInTheDocument();
    act(() => sessionStatus.report(true));
    expect(screen.queryByRole('alert', { name: NAME })).toBeNull();
  });
});
