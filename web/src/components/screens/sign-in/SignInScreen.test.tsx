import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SignInScreen, type SignInScreenProps } from './SignInScreen';

const renderScreen = (props: Partial<SignInScreenProps> = {}) =>
  render(<SignInScreen mode="sign-in" next={null} linkError={false} deleted={false} {...props} />);

describe('SignInScreen', () => {
  it('leads with the promise, highlighting "with your own numbers"', () => {
    renderScreen();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent("Your first month's money decisions, with your own numbers.");
    expect(heading).toHaveClass('text-display');
    expect(screen.getByText('with your own numbers.')).toHaveClass('text-coral-text');
  });

  it('explains the three guarantees', () => {
    renderScreen();
    for (const title of [
      'Money math runs in tested code.',
      'AI reads, it does not decide.',
      'A monthly check-in.',
    ]) {
      expect(screen.getByText(title).tagName).toBe('STRONG');
    }
  });

  it('shows the sign-in form', () => {
    renderScreen();
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/sign-in?mode=sign-up',
    );
  });

  it('shows the create-account form, keeping the next path', () => {
    renderScreen({ mode: 'sign-up', next: '/setup/link' });
    expect(screen.getByRole('form', { name: 'Create an account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/sign-in?next=/setup/link',
    );
  });

  it('starts a fresh form when the mode changes', () => {
    const { rerender } = renderScreen({ linkError: true });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    rerender(<SignInScreen mode="sign-up" next={null} linkError={false} deleted={false} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the link error from /auth/callback', () => {
    renderScreen({ linkError: true });
    expect(screen.getByRole('alert')).toHaveTextContent('That sign-in link is invalid');
  });

  it('says calmly that the account was deleted, above the sign-in form', () => {
    renderScreen({ deleted: true });
    expect(screen.getByRole('status')).toHaveTextContent('Your account and its data were deleted.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('says nothing about deletion otherwise', () => {
    renderScreen();
    expect(screen.queryByText(/were deleted/)).toBeNull();
  });
});
