import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppSideNav } from './AppSideNav';

const pathname = vi.hoisted(() => ({ current: '/setup/spending' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

describe('AppSideNav', () => {
  it('marks the screen for the current path', () => {
    pathname.current = '/setup/spending';
    render(<AppSideNav />);
    expect(screen.getByRole('link', { name: 'Spending map' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('passes done marks through', () => {
    pathname.current = '/plan';
    render(<AppSideNav done={{ link: true }} />);
    expect(screen.getByRole('link', { name: 'Accounts and documents, done' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Plan and calendar' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
