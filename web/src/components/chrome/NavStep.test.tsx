import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { toneSoft } from '@/lib/design/tone';
import { NavStep } from './NavStep';

describe('NavStep', () => {
  it('draws a 22px neutral circle around the step number', () => {
    const { container } = render(<NavStep>1</NavStep>);
    const step = container.firstElementChild;
    expect(step).toHaveAttribute('aria-hidden', 'true');
    expect(step).toHaveClass('size-[22px]', 'rounded-full', 'bg-ink/7', 'text-ink-2');
    expect(step).toHaveTextContent('1');
  });

  it('turns into a confirmed check when done', () => {
    const { container } = render(<NavStep done>1</NavStep>);
    const step = container.firstElementChild;
    expect(step).toHaveClass(...toneSoft.confirmed.split(' '));
    expect(step).not.toHaveTextContent('1');
    expect(step?.querySelector('svg')).not.toBeNull();
  });

  it('draws a smaller 18px circle for a sub-step, with a smaller check when done', () => {
    const { container, rerender } = render(<NavStep size="sm">·</NavStep>);
    expect(container.firstElementChild).toHaveClass('size-[18px]', 'bg-ink/7');
    rerender(
      <NavStep size="sm" done>
        ·
      </NavStep>,
    );
    expect(container.firstElementChild).toHaveClass('size-[18px]');
    expect(container.querySelector('svg')).toHaveAttribute('width', '10');
  });
});
