import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Money, Num } from './Money';

describe('Money', () => {
  it('formats integer cents with tabular numerals', () => {
    render(<Money cents={199604} />);
    expect(screen.getByText('$1,996.04')).toHaveClass('tabular-nums');
  });

  it('rounds to whole dollars with decimals 0', () => {
    render(<Money cents={182325} decimals={0} />);
    expect(screen.getByText('$1,823')).toBeInTheDocument();
  });

  it('signs a change', () => {
    render(<Money cents={85754} signed />);
    expect(screen.getByText('+$857.54')).toBeInTheDocument();
  });

  it('colors through tone', () => {
    render(<Money cents={260000} decimals={0} tone="plum" />);
    expect(screen.getByText('$2,600')).toHaveClass('text-plum-text');
  });
});

describe('Num', () => {
  it('formats a count with grouping and tabular numerals', () => {
    render(<Num value={1234} />);
    expect(screen.getByText('1,234')).toHaveClass('tabular-nums');
  });

  it('formats decimals and percent', () => {
    render(
      <>
        <Num value={14.21} decimals={2} />
        <Num value={12} percent />
      </>,
    );
    expect(screen.getByText('14.21')).toBeInTheDocument();
    expect(screen.getByText('12%')).toBeInTheDocument();
  });

  it('signs and colors', () => {
    render(<Num value={-3} signed tone="off" />);
    expect(screen.getByText('-3')).toHaveClass('text-red-text');
  });
});
