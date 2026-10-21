import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import Home from './page';

describe('the root page', () => {
  beforeEach(() => {
    mocks.getCurrentUser.mockReset();
  });

  it('sends a signed-in person to the first setup step', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'u1' });
    await expect(Home()).rejects.toThrow('NEXT_REDIRECT /setup/link');
  });

  it('sends everyone else to sign in', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    await expect(Home()).rejects.toThrow('NEXT_REDIRECT /sign-in');
  });
});
