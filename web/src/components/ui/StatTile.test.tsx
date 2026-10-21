import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatTile } from './StatTile';

describe('StatTile', () => {
  it('shows an uppercase label over a 22px tabular value and a sub line', () => {
    render(<StatTile label="Income" value="$3,992.08" sub="2 × $1,996.04 net" tone="plum" />);
    expect(screen.getByText('Income')).toHaveClass('uppercase', 'text-tiny', 'text-plum-text');
    expect(screen.getByText('$3,992.08')).toHaveClass(
      'text-stat',
      'font-bold',
      'tabular-nums',
      'text-plum-text',
    );
    expect(screen.getByText('2 × $1,996.04 net')).toHaveClass('text-tiny', 'text-ink-3');
    expect(screen.getByText('Income').parentElement).toHaveClass('bg-plum-tint', 'rounded-tile');
  });

  it('uses the tile ground and ink for neutral', () => {
    render(<StatTile label="Retries" value="0" />);
    expect(screen.getByText('Retries')).toHaveClass('text-ink-3');
    expect(screen.getByText('0')).toHaveClass('text-ink');
    expect(screen.getByText('Retries').parentElement).toHaveClass('bg-tile');
  });

  it('has a compact size for the plan paper', () => {
    render(<StatTile size="sm" label="Salary" value="$65,000" tone="blue" />);
    expect(screen.getByText('Salary')).not.toHaveClass('uppercase');
    expect(screen.getByText('$65,000')).not.toHaveClass('text-stat');
    expect(screen.getByText('Salary').parentElement).toHaveClass('rounded-seg', 'bg-blue-tint');
  });

  it('omits the sub line when absent', () => {
    const { container } = render(<StatTile label="Savings" value="$300.00" tone="teal" />);
    expect(container.firstElementChild?.children).toHaveLength(2);
  });

  it('shows a skeleton instead of a value while loading, and says it is busy', () => {
    const { container } = render(
      <StatTile loading label="Income" value="$3,992.08" sub="2 paychecks" tone="plum" />,
    );
    const tile = container.firstElementChild as HTMLElement;
    expect(tile).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.queryByText('$3,992.08')).not.toBeInTheDocument();
    expect(screen.queryByText('2 paychecks')).not.toBeInTheDocument();
    expect(tile.querySelectorAll('[data-skeleton]')).toHaveLength(2);
  });
});
