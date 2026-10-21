import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: mocks.getCurrentUser }));

import { HeaderAccount } from './HeaderAccount';

async function renderAccount() {
  const { container } = render(<>{await HeaderAccount()}</>);
  return container;
}

describe('HeaderAccount', () => {
  beforeEach(() => {
    mocks.getCurrentUser.mockReset();
  });

  it('renders nothing for a signed-out visitor', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect(await renderAccount()).toBeEmptyDOMElement();
  });

  it("shows the person's email as the user menu", async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'u1', email: 'alex@example.com' });
    await renderAccount();
    expect(screen.getByRole('button', { name: 'alex@example.com' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
