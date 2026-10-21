import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Swatch } from './Swatch';

describe('Swatch', () => {
  it('draws a small decorative square in a token color', () => {
    const { container } = render(<Swatch color="flow-tax" />);
    const swatch = container.firstElementChild;
    expect(swatch).toHaveAttribute('aria-hidden', 'true');
    expect(swatch).toHaveClass('size-2.5', 'rounded-[3px]', 'bg-flow-tax');
  });

  it.each([
    'blue',
    'coral',
    'teal',
    'plum',
    'ink-2',
    'flow-idle',
    'blue-soft',
    'coral-soft',
  ] as const)('supports %s', (color) => {
    const { container } = render(<Swatch color={color} />);
    expect(container.firstElementChild).toHaveClass(`bg-${color}`);
  });

  it('outlines a dashed empty swatch for a zero-value node', () => {
    const { container } = render(<Swatch dashed />);
    expect(container.firstElementChild).toHaveClass(
      'border-dashed',
      'border-flow-tax',
      'bg-transparent',
    );
  });

  it('has the 12px node size', () => {
    const { container } = render(<Swatch color="blue" size={12} />);
    expect(container.firstElementChild).toHaveClass('size-3');
  });
});
