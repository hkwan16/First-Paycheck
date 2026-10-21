import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Header } from './Header';

describe('Header', () => {
  it('is a sticky translucent banner with the wordmark and context chips', () => {
    render(<Header chips={['Acme Corp · Semi-monthly', 'J. Rivera']} />);
    const banner = screen.getByRole('banner');
    expect(banner).toHaveClass(
      'sticky',
      'top-0',
      'bg-ground/72',
      'backdrop-blur-[20px]',
      'border-b',
      'border-line',
    );
    expect(screen.getByRole('link', { name: 'First Paycheck home' })).toBeInTheDocument();
    expect(screen.getByText('Acme Corp · Semi-monthly')).toHaveClass('bg-fill');
    expect(screen.getByText('J. Rivera')).toBeInTheDocument();
  });

  it('turns solid when the viewer asks for reduced transparency', () => {
    render(<Header />);
    expect(screen.getByRole('banner')).toHaveClass(
      'reduce-transparency:bg-ground',
      'reduce-transparency:backdrop-blur-none',
    );
  });

  it('shows only the wordmark in minimal mode', () => {
    render(<Header minimal chips={['J. Rivera']} />);
    expect(screen.queryByText('J. Rivera')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'First Paycheck home' })).toBeInTheDocument();
  });
});
