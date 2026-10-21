import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SignInScreen } from './SignInScreen';

/** Render with the page's searchParams, letting the Suspense boundary resolve. */
async function renderScreen(searchParams: Record<string, string | string[]> = {}) {
  await act(async () => {
    render(<SignInScreen searchParams={Promise.resolve(searchParams)} />);
  });
}

describe('SignInScreen', () => {
  it('leads with the promise, highlighting "with your own numbers"', async () => {
    await renderScreen();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent("Your first month's money decisions, with your own numbers.");
    expect(heading).toHaveClass('text-display');
    expect(screen.getByText('with your own numbers.')).toHaveClass('text-coral-text');
  });

  it('explains the three guarantees', async () => {
    await renderScreen();
    for (const title of [
      'Money math runs in tested code.',
      'AI reads, it does not decide.',
      'A monthly check-in.',
    ]) {
      expect(screen.getByText(title).tagName).toBe('STRONG');
    }
  });

  it('shows the sign-in form by default', async () => {
    await renderScreen();
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/sign-in?mode=sign-up',
    );
  });

  it('creates an account with ?mode=sign-up and keeps a safe next path', async () => {
    await renderScreen({ mode: 'sign-up', next: '/setup/link' });
    expect(screen.getByRole('form', { name: 'Create an account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/sign-in?next=/setup/link',
    );
  });

  it('ignores an unsafe or repeated next path', async () => {
    await renderScreen({ next: ['/plan', 'https://evil.example'] });
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/sign-in?mode=sign-up',
    );
  });

  it('ignores an absolute next path', async () => {
    await renderScreen({ next: 'https://evil.example' });
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/sign-in?mode=sign-up',
    );
  });

  it('shows the link error from /auth/callback', async () => {
    await renderScreen({ error: 'link' });
    expect(screen.getByRole('alert')).toHaveTextContent('That sign-in link is invalid');
  });
});
