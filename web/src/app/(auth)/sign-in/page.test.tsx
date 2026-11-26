import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/hydration-marker', () => ({ HydrationMarker: () => null }));

import SignInPage, { generateMetadata } from './page';

const pageProps = (query: Record<string, string> = {}) => ({
  params: Promise.resolve({}),
  searchParams: Promise.resolve(query),
});

describe('the sign-in page (issue 271)', () => {
  it('titles the tab "Sign in" for the sign-in form', async () => {
    const props = pageProps();
    await expect(generateMetadata(props)).resolves.toEqual({ title: 'Sign in' });
    render(await SignInPage(props));
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('titles the tab "Create an account" for ?mode=sign-up, the same as the form', async () => {
    const props = pageProps({ mode: 'sign-up' });
    await expect(generateMetadata(props)).resolves.toEqual({ title: 'Create an account' });
    render(await SignInPage(props));
    expect(screen.getByRole('form', { name: 'Create an account' })).toBeInTheDocument();
  });
});
