import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, userEvent } from '@/test/render';
import AppError from './error';

let consoleError: MockInstance<typeof console.error>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('the (app) error boundary', () => {
  it('says the page could not be shown, with a reload link and Try again', async () => {
    const retry = vi.fn();
    render(<AppError error={new Error('boom')} retry={retry} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'This page could not be shown' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Something went wrong while showing this page. Nothing you saved has changed.',
    );
    // A plain link to this same address: a full reload, not a client-side navigation.
    const reload = screen.getByRole('link', { name: 'Reload the page' });
    expect(reload).toHaveAttribute('href', window.location.href);
    expect(reload.tagName).toBe('A');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('logs the error once, even when Strict Mode runs effects twice', () => {
    const error = new Error('boom');
    render(
      <StrictMode>
        <AppError error={error} retry={vi.fn()} />
      </StrictMode>,
    );
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      '[AppError] a page failed to render',
      error,
    );
  });
});
