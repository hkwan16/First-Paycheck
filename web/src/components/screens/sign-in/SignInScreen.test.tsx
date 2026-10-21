import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SignInScreen } from './SignInScreen';

describe('SignInScreen', () => {
  it('leads with the promise, highlighting "with your own numbers"', () => {
    render(<SignInScreen />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent("Your first month's money decisions, with your own numbers.");
    expect(heading).toHaveClass('text-display');
    expect(screen.getByText('with your own numbers.')).toHaveClass('text-coral-text');
  });

  it('explains the three guarantees', () => {
    render(<SignInScreen />);
    for (const title of [
      'Money math runs in tested code.',
      'AI reads, it does not decide.',
      'A monthly check-in.',
    ]) {
      expect(screen.getByText(title).tagName).toBe('STRONG');
    }
  });

  it('has a labeled sign-in form with email and password', () => {
    render(<SignInScreen />);
    const form = screen.getByRole('form', { name: 'Sign in' });
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeInTheDocument();
    expect(form).toHaveClass('rounded-card');
  });

  it('does not navigate on submit until auth is wired', () => {
    render(<SignInScreen />);
    const notPrevented = fireEvent.submit(screen.getByRole('form', { name: 'Sign in' }));
    expect(notPrevented).toBe(false);
  });

  it('links to account creation', () => {
    render(<SignInScreen />);
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/sign-in?mode=sign-up',
    );
  });
});
