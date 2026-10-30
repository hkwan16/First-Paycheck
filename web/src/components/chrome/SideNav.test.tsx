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
    const [setup, plan] = within(nav)
      .getAllByRole('list')
      .filter((list) => list.parentElement?.tagName === 'NAV');
    expect(
      [...(setup as HTMLElement).children].map((li) => li.firstElementChild?.textContent),
    ).toEqual(['1Accounts and documents', '2Confirm pay stub', '3Spending map', '4Decisions']);
    expect(
      within(plan as HTMLElement)
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

  it('checks off the plan once every decision is in it', () => {
    render(<SideNav done={{ plan: true }} />);
    expect(screen.getByRole('link', { name: 'Plan and calendar, done' })).toHaveAttribute(
      'href',
      '/plan',
    );
  });

  it('wraps into a chip row under the nav breakpoint', () => {
    render(<SideNav />);
    for (const list of screen.getAllByRole('list')) {
      expect(list).toHaveClass('max-nav:flex-row', 'max-nav:flex-wrap');
    }
  });
});

const ALL = ['emergency_fund', '401k_match', 'health_plan', 'w4'] as const;

/** The nested list of steps under Decisions. */
const steps = () =>
  within(screen.getByRole('link', { name: /^Decisions/ }).closest('li') as HTMLElement).getByRole(
    'list',
  );

describe('SideNav decision steps (spec 018)', () => {
  it('nests the four steps under Decisions in step order, each linking to its page', () => {
    render(<SideNav calculators={ALL} />);
    const links = within(steps()).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Emergency fund', '/setup/decisions/emergency-fund'],
      ['401(k) match', '/setup/decisions/401k'],
      ['Health plan', '/setup/decisions/health-plan'],
      ['W-4', '/setup/decisions/w4'],
    ]);
    for (const link of links) expect(link).toHaveClass('min-h-11');
  });

  it('links Decisions to the first live step', () => {
    const { unmount } = render(<SideNav calculators={ALL} />);
    expect(screen.getByRole('link', { name: 'Decisions' })).toHaveAttribute(
      'href',
      '/setup/decisions/emergency-fund',
    );
    unmount();
    render(<SideNav calculators={['401k_match']} />);
    expect(screen.getByRole('link', { name: 'Decisions' })).toHaveAttribute(
      'href',
      '/setup/decisions/401k',
    );
  });

  it('marks the current step as the page, and not Decisions', () => {
    render(<SideNav calculators={ALL} current="health_plan" />);
    expect(screen.getByRole('link', { name: 'Health plan' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Decisions' })).not.toHaveAttribute('aria-current');
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(1);
  });

  it('checks off each saved step, and Decisions once every live one is', () => {
    render(<SideNav calculators={ALL} done={{ decisions: true, '401k_match': true, w4: true }} />);
    const k401 = screen.getByRole('link', { name: '401(k) match, done' });
    expect(k401.querySelector('[aria-hidden="true"]')).toHaveClass(
      ...toneSoft.confirmed.split(' '),
    );
    expect(screen.getByRole('link', { name: 'W-4, done' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Health plan' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Decisions, done' })).toBeInTheDocument();
  });

  it('mutes a step that is not live, says After alpha, and still links to its page', () => {
    render(<SideNav calculators={['401k_match']} />);
    for (const [name, href] of [
      ['Emergency fund', '/setup/decisions/emergency-fund'],
      ['Health plan', '/setup/decisions/health-plan'],
      ['W-4', '/setup/decisions/w4'],
    ]) {
      const link = screen.getByRole('link', { name: `${name}, After alpha` });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveClass('text-ink-3');
    }
    const live = screen.getByRole('link', { name: '401(k) match' });
    expect(live).not.toHaveClass('text-ink-3');
    expect(within(steps()).getAllByText('After alpha')).toHaveLength(3);
  });

  it('gives the steps a wrapping row of their own under the nav breakpoint', () => {
    render(<SideNav calculators={ALL} />);
    const decisions = screen.getByRole('link', { name: 'Decisions' }).closest('li');
    expect(decisions).toHaveClass('max-nav:basis-full');
    expect(steps()).toHaveClass('max-nav:flex-row', 'max-nav:flex-wrap');
  });
});

describe('navKeyForPath', () => {
  it.each([
    ['/setup/link', 'link'],
    ['/setup/confirm/doc_1', 'confirm'],
    ['/setup/confirm', 'confirm'],
    ['/setup/spending', 'spending'],
    ['/setup/decisions/emergency-fund', 'emergency_fund'],
    ['/setup/decisions/401k', '401k_match'],
    ['/setup/decisions/health-plan', 'health_plan'],
    ['/setup/decisions/w4', 'w4'],
    ['/setup/decisions', undefined],
    ['/setup/decisions/roth', undefined],
    ['/why/dec_1', 'why'],
    ['/why', 'why'],
    ['/plan', 'plan'],
    ['/check-in/ci_1', 'checkIn'],
    ['/check-in', 'checkIn'],
    ['/sign-in', undefined],
    ['/setup/linked', undefined],
  ])('%s is %s', (path, key) => {
    expect(navKeyForPath(path)).toBe(key);
  });
});
