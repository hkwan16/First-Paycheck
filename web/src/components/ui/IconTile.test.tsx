import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IconTile } from './IconTile';

describe('IconTile', () => {
  it('renders a decorative 36px tinted square around an icon', () => {
    const { container } = render(
      <IconTile tone="teal">
        <svg data-testid="icon" />
      </IconTile>,
    );
    const tile = container.firstElementChild;
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    expect(tile).toHaveClass('size-9', 'rounded-control', 'bg-teal-tint', 'text-teal-text');
    expect(tile?.querySelector('[data-testid="icon"]')).not.toBeNull();
  });

  it('shows initials when given a label', () => {
    const { container } = render(<IconTile tone="blue" label="CH" />);
    expect(container.firstElementChild).toHaveTextContent('CH');
    expect(container.firstElementChild).toHaveClass('text-tiny', 'font-bold');
  });

  it('reaches status colors through tone', () => {
    const { container } = render(<IconTile tone="off" label="!" />);
    expect(container.firstElementChild).toHaveClass('bg-red-tint', 'text-red-text');
  });

  it('mutes to neutral for handled items', () => {
    const { container } = render(<IconTile tone="plum" muted label="x" />);
    expect(container.firstElementChild).toHaveClass('bg-fill', 'text-ink-2');
    expect(container.firstElementChild).not.toHaveClass('bg-plum-tint');
  });
});
