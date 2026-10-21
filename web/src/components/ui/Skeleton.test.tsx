import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('is a decorative placeholder that pulses, and holds still under reduced motion', () => {
    const { container } = render(<Skeleton className="w-24" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block).toHaveAttribute('aria-hidden', 'true');
    expect(block).toHaveAttribute('data-skeleton');
    expect(block).toHaveClass(
      'animate-pulse',
      'motion-reduce:animate-none',
      'bg-fill-strong',
      'w-24',
    );
  });

  it('sits on the text line by default, or fills a block', () => {
    const { container } = render(
      <>
        <Skeleton />
        <Skeleton block className="h-9" />
      </>,
    );
    const [line, block] = Array.from(container.children) as HTMLElement[];
    expect(line).toHaveClass('inline-block', 'h-[1em]');
    expect(block).toHaveClass('block', 'h-9');
  });
});
