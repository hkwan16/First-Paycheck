import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { toneSoft } from '@/lib/design/tone';
import { checkInRoute, confirmRoute, whyRoute } from '@/lib/routes';
import { navKeyForPath, SideNav } from './SideNav';

describe('SideNav', () => {
  it('groups the setup steps and the plan screens', () => {
    render(<SideNav />);
    const nav = screen.getByRole('navigation', { name: 'Setup steps' });
    expect(within(nav).getByText('Setup')).toHaveClass('uppercase', 'text-micro');
    expect(within(nav).getByText('Your plan')).toBeInTheDocument();
    const lists = within(nav).getAllByRole('list');
    expect(lists).toHaveLength(2);
    expect(
      within(lists[0] as HTMLElement)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['1Accounts and documents', '2Confirm pay stub', '3Spending map', '4Decisions']);
    expect(
      within(lists[1] as HTMLElement)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Why this decision', 'Plan and calendar', 'Monthly check-in']);
  });

  it('links the routes that need no id', () => {
    render(<SideNav />);
    expect(screen.getByRole('link', { name: 'Accounts and documents' })).toHaveAttribute(
      'href',
      '/setup/link',
    );
    expect(screen.getByRole('link', { name: 'Spending map' })).toHaveAttribute(
      'href',
      '/setup/spending',
    );
    expect(screen.getByRole('link', { name: 'Decisions' })).toHaveAttribute(
      'href',
      '/setup/decisions',
    );
    expect(screen.getByRole('link', { name: 'Plan and calendar' })).toHaveAttribute(
      'href',
      '/plan',
    );
  });

  it('shows id-bound screens as unavailable until an href is known', () => {
    render(<SideNav />);
    expect(screen.queryByRole('link', { name: 'Monthly check-in' })).not.toBeInTheDocument();
    expect(screen.getByText('Monthly check-in').closest('[aria-disabled]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('links Why this decision to the list of saved decisions', () => {
    render(<SideNav />);
    expect(screen.getByRole('link', { name: 'Why this decision' })).toHaveAttribute('href', '/why');
  });

  it('links Confirm to the page that finds the pay stub waiting for review', () => {
    render(<SideNav />);
    expect(screen.getByRole('link', { name: 'Confirm pay stub' })).toHaveAttribute(
      'href',
      '/setup/confirm',
    );
  });

  it('links id-bound screens once given hrefs', () => {
    render(
      <SideNav
        hrefs={{
          confirm: confirmRoute('doc_1'),
          why: whyRoute('dec_1'),
          checkIn: checkInRoute('ci_1'),
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Confirm pay stub' })).toHaveAttribute(
      'href',
      '/setup/confirm/doc_1',
    );
    expect(screen.getByRole('link', { name: 'Why this decision' })).toHaveAttribute(
      'href',
      '/why/dec_1',
    );
    expect(screen.getByRole('link', { name: 'Monthly check-in' })).toHaveAttribute(
      'href',
      '/check-in/ci_1',
    );
  });

  it('marks the current screen', () => {
    render(<SideNav current="spending" />);
    const link = screen.getByRole('link', { name: 'Spending map' });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveClass('aria-[current=page]:bg-surface', 'aria-[current=page]:shadow-raised');
    expect(screen.getByRole('link', { name: 'Decisions' })).not.toHaveAttribute('aria-current');
  });

  it('checks off finished setup steps and says so to screen readers', () => {
    render(<SideNav done={{ link: true, confirm: false }} />);
    const link = screen.getByRole('link', { name: 'Accounts and documents, done' });
    expect(link.querySelector('[aria-hidden="true"]')).toHaveClass(
      ...toneSoft.confirmed.split(' '),
    );
  });

  it('wraps into a chip row under the nav breakpoint', () => {
    render(<SideNav />);
    for (const list of screen.getAllByRole('list')) {
      expect(list).toHaveClass('max-nav:flex-row', 'max-nav:flex-wrap');
    }
  });
});

describe('navKeyForPath', () => {
  it.each([
    ['/setup/link', 'link'],
    ['/setup/confirm/doc_1', 'confirm'],
    ['/setup/confirm', 'confirm'],
    ['/setup/spending', 'spending'],
    ['/setup/decisions', 'decisions'],
    ['/why/dec_1', 'why'],
    ['/why', 'why'],
    ['/plan', 'plan'],
    ['/check-in/ci_1', 'checkIn'],
    ['/sign-in', undefined],
    ['/setup/linked', undefined],
  ])('%s is %s', (path, key) => {
    expect(navKeyForPath(path)).toBe(key);
  });
});
