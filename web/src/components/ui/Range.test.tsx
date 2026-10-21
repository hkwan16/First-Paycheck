import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Range } from './Range';

describe('Range', () => {
  function Controlled({ onChange }: { onChange?: (v: number) => void }) {
    const [value, setValue] = useState(4);
    return (
      <Range
        id="k-pct"
        label="Your contribution"
        valueLabel={`${value}% of salary`}
        min={0}
        max={15}
        step={1}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    );
  }

  it('labels the slider with a two-sided row: name and current value', () => {
    render(<Controlled />);
    const slider = screen.getByRole('slider', { name: /Your contribution/ });
    expect(slider).toHaveAttribute('aria-valuetext', '4% of salary');
    expect(screen.getByText('4% of salary')).toHaveClass('tabular-nums');
    expect(slider).toHaveClass('h-11', 'accent-blue');
  });

  it('reports numbers, not strings', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '6' } });
    expect(onChange).toHaveBeenCalledWith(6);
    expect(screen.getByText('6% of salary')).toBeInTheDocument();
  });
});
