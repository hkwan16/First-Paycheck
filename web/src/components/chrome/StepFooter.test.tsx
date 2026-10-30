import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { requestLandAtTop } from '@/lib/land-at-top';
import { StepFooter } from './StepFooter';

// What each Next link was given, besides what it renders.
const links = vi.hoisted(() => [] as { href: unknown; scroll: unknown; onNavigate: unknown }[]);
vi.mock('next/link', () => ({
  default: ({
    href,
    scroll,
    onNavigate,
    className,
    children,
  }: ComponentProps<'a'> & {
    scroll?: boolean;
    onNavigate?: () => void;
  }) => {
    links.push({ href, scroll, onNavigate });
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  },
}));

describe('StepFooter', () => {
  it('lands the next step at the top of the page, not where Next would scroll (issue 172)', () => {
    links.length = 0;
    render(
      <StepFooter
        back={{ href: '/setup/decisions/emergency-fund' }}
        next={{ href: '/setup/decisions/health-plan', label: 'Next: health plan' }}
      />,
    );
    expect(links).toEqual([
      { href: '/setup/decisions/emergency-fund', scroll: false, onNavigate: requestLandAtTop },
      { href: '/setup/decisions/health-plan', scroll: false, onNavigate: requestLandAtTop },
    ]);
  });

  it('puts Back on the left and a primary next link with an arrow on the right', () => {
    render(
      <StepFooter
        back={{ href: '/setup/link' }}
        next={{ href: '/setup/spending', label: 'Review extracted fields' }}
      />,
    );
    const back = screen.getByRole('link', { name: 'Back' });
    expect(back).toHaveAttribute('href', '/setup/link');
    expect(back).toHaveClass('bg-fill');
    const next = screen.getByRole('link', { name: 'Review extracted fields' });
    expect(next).toHaveAttribute('href', '/setup/spending');
    expect(next).toHaveClass('bg-blue');
    expect(next.querySelector('svg')).not.toBeNull();
    expect(back.parentElement).toHaveClass('justify-between');
  });

  it('makes a not-yet-ready next step a real disabled button', () => {
    render(
      <StepFooter
        next={{ href: '/setup/spending', label: 'Confirm and continue', disabled: true }}
        status="3 left to confirm"
      />,
    );
    expect(screen.queryByRole('link', { name: 'Confirm and continue' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm and continue' })).toBeDisabled();
    expect(screen.getByText('3 left to confirm')).toHaveClass('text-small', 'text-ink-3');
  });

  it('runs an action instead of navigating', async () => {
    const onClick = vi.fn();
    render(<StepFooter next={{ label: 'Confirm and continue', onClick }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and continue' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps the next action busy while it runs', async () => {
    const onClick = vi.fn();
    render(<StepFooter next={{ label: 'Confirm and continue', onClick, loading: true }} />);
    const next = screen.getByRole('button', { name: 'Confirm and continue' });
    expect(next).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(next);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('uses a secondary next when asked', () => {
    render(<StepFooter next={{ href: '/plan', label: 'Skip', primary: false }} />);
    expect(screen.getByRole('link', { name: 'Skip' })).toHaveClass('bg-fill');
  });

  it('can relabel Back', () => {
    render(<StepFooter back={{ href: '/setup/decisions/w4', label: 'Back to decisions' }} />);
    expect(screen.getByRole('link', { name: 'Back to decisions' })).toBeInTheDocument();
  });
});
