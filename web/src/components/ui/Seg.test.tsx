import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Seg } from './Seg';

type Usage = 'low' | 'medium' | 'high';
const options = [
  { value: 'low', label: 'Low · about $400' },
  { value: 'medium', label: 'Medium · about $1,800' },
  { value: 'high', label: 'High · about $6,000' },
] as const;

function Controlled({ onChange }: { onChange?: (value: Usage) => void }) {
  const [value, setValue] = useState<Usage>('low');
  return (
    <Seg
      label="Expected healthcare use"
      options={options}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('Seg', () => {
  it('is a labeled group of toggle buttons with one pressed', () => {
    render(<Controlled />);
    const group = screen.getByRole('group', { name: 'Expected healthcare use' });
    expect(group).toHaveClass('bg-fill', 'rounded-control');
    expect(screen.getByRole('button', { name: 'Low · about $400' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Medium · about $1,800' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('selects on click', async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /High/ }));
    expect(onChange).toHaveBeenCalledWith('high');
    expect(screen.getByRole('button', { name: /High/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is one tab stop, on the pressed option', async () => {
    render(
      <>
        <Controlled />
        <button type="button">after</button>
      </>,
    );
    await userEvent.tab();
    expect(screen.getByRole('button', { name: /Low/ })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });

  it('moves and selects with the arrow keys, wrapping at the ends', async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: /Medium/ })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('medium');
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('button', { name: /Low/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: /High/ })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('high');
  });

  it('jumps with Home and End', async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await userEvent.tab();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('button', { name: /High/ })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('button', { name: /Low/ })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('low');
  });

  it('styles the pressed option as a raised thumb with press feedback', () => {
    render(<Controlled />);
    expect(screen.getByRole('button', { name: /Low/ })).toHaveClass(
      'aria-pressed:bg-surface',
      'aria-pressed:shadow-thumb',
      'active:scale-[.97]',
      'motion-reduce:active:scale-100',
    );
  });
});
