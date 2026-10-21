import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StepFooter } from './StepFooter';

describe('StepFooter', () => {
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

  it('uses a secondary next when asked', () => {
    render(<StepFooter next={{ href: '/plan', label: 'Skip', primary: false }} />);
    expect(screen.getByRole('link', { name: 'Skip' })).toHaveClass('bg-fill');
  });

  it('can relabel Back', () => {
    render(<StepFooter back={{ href: '/setup/decisions', label: 'Back to decisions' }} />);
    expect(screen.getByRole('link', { name: 'Back to decisions' })).toBeInTheDocument();
  });
});
