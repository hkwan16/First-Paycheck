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
    expect(screen.queryByText('Sample data')).toBeNull();
  });

  it('prefers the name on the profile', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({
      id: 'u1',
      email: 'alex@example.com',
      user_metadata: { full_name: 'Alex Rivera' },
    });
    await renderAccount();
    expect(screen.getByRole('button', { name: 'Alex Rivera' })).toBeInTheDocument();
  });

  it('adds a "Sample data" chip before the user chip for the e2e account', async () => {
    vi.stubEnv('NEXT_PUBLIC_E2E_USER_EMAIL', 'e2e@example.com');
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'u1', email: 'e2e@example.com' });
    await renderAccount();
    const chip = screen.getByText('Sample data');
    const menu = screen.getByRole('button', { name: 'e2e@example.com' });
    expect(chip).toHaveClass('bg-fill', 'rounded-full');
    expect(chip.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no "Sample data" chip for anyone else', async () => {
    vi.stubEnv('NEXT_PUBLIC_E2E_USER_EMAIL', 'e2e@example.com');
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'u2', email: 'alex@example.com' });
    await renderAccount();
    expect(screen.queryByText('Sample data')).toBeNull();
  });
});
