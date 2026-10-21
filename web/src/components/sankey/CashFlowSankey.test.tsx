import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleCashflow } from '@/test/fixtures/cashflow';
import { act, fireEvent, render, screen, userEvent, within } from '@/test/render';
import { CashFlowSankey } from './CashFlowSankey';
import type { FlowNode } from './layout';
import { GRACE_MS } from './useFlowPopover';

const details = (node: FlowNode) => <p>Details for {node.id}</p>;

function renderSankey(width = 928) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const view = render(
    <>
      <button type="button">Before</button>
      <CashFlowSankey flow={sampleCashflow()} width={width} renderDetails={details} />
      <button type="button">After</button>
    </>,
  );
  return { user, ...view };
}

const node = (name: RegExp | string) => screen.getByRole('button', { name });
const popover = () => screen.queryByRole('group', { name: /./ });

describe('CashFlowSankey', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('draws one button per node, named with its amount as the API sent it', () => {
    renderSankey();
    expect(node('Gross pay, 2 stubs $5,416.66')).toBeInTheDocument();
    expect(node('Federal tax $595.52')).toBeInTheDocument();
    expect(node('Take-home $3,992.08')).toBeInTheDocument();
    expect(node('Essentials $1,823.25')).toBeInTheDocument();
    expect(node('Not yet spent $1,618.94')).toBeInTheDocument();
    expect(node('Phone and internet $70.00')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /\$/ })).toHaveLength(22);
  });

  it('draws the bands as one decorative SVG image, each band in its token color', () => {
    const { container } = renderSankey();
    const svg = screen.getByRole('img', { name: /Cash flow bands/ });
    const bands = svg.querySelectorAll('path');
    // Seven out of gross (no band to the $0 401(k)), four out of take-home, nine to categories.
    expect(bands).toHaveLength(20);
    expect(container.querySelector('path.fill-flow-tax')).not.toBeNull();
    expect(container.querySelector('path.fill-blue-soft')).not.toBeNull();
  });

  it('marks a $0 node dashed', () => {
    renderSankey();
    expect(node('401(k), not elected $0.00')).toHaveClass('border-dashed');
    expect(node('Federal tax $595.52')).not.toHaveClass('border-dashed');
  });

  it('heads the columns', () => {
    renderSankey();
    for (const heading of [
      'Pay stubs',
      'Withheld and deducted',
      'Take-home buckets',
      'Categories',
    ]) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
  });

  it('lays out at the container width, and scrolls sideways below 880 px', () => {
    const { container, rerender } = renderSankey(928);
    const host = () => container.querySelector<HTMLElement>('[data-flow-host]')!;
    expect(host().style.width).toBe('928px');
    expect(host().parentElement).not.toHaveClass('overflow-x-auto');

    rerender(<CashFlowSankey flow={sampleCashflow()} width={700} renderDetails={details} />);
    expect(host().style.width).toBe('880px');
    expect(host().parentElement).toHaveClass('overflow-x-auto');
  });

  it('opens a popover on hover with the node, its amount and the screen details', async () => {
    const { user } = renderSankey();
    await user.hover(node('Essentials $1,823.25'));
    const group = popover()!;
    expect(group).toHaveAccessibleName('Essentials');
    expect(group).toHaveTextContent('$1,823.25');
    expect(within(group).getByText('Details for bucket:essentials')).toBeInTheDocument();
    expect(node('Essentials $1,823.25')).toHaveAttribute('aria-expanded', 'true');
    expect(node('Essentials $1,823.25')).toHaveAttribute('aria-controls', group.id);
    expect(node('Flexible $249.89')).toHaveAttribute('aria-expanded', 'false');
    expect(node('Flexible $249.89')).not.toHaveAttribute('aria-controls');

    await user.unhover(node('Essentials $1,823.25'));
    await act(() => vi.advanceTimersByTimeAsync(GRACE_MS));
    expect(popover()).toBeNull();
  });

  it('opens the node a band flows into when the band is hovered', async () => {
    const { container } = renderSankey();
    const band = container.querySelector('path.fill-blue')!;
    fireEvent.pointerOver(band, { pointerType: 'mouse' });
    expect(popover()).toHaveAccessibleName('Essentials');
  });

  it('lights the open node and its bands, and dims the others', async () => {
    const { user, container } = renderSankey();
    const opacity = (selector: string) =>
      Number(container.querySelector(selector)!.getAttribute('fill-opacity'));
    const resting = opacity('path.fill-blue');
    await user.hover(node('Essentials $1,823.25'));
    expect(opacity('path.fill-blue')).toBeGreaterThan(resting);
    expect(opacity('path.fill-coral-soft')).toBeLessThan(0.45);
    expect(node('Essentials $1,823.25')).toHaveClass('ring-2', 'ring-blue');
  });

  it('is one tab stop; arrows move between nodes and open each one', async () => {
    const { user } = renderSankey();
    await user.click(screen.getByRole('button', { name: 'Before' }));
    await user.tab();
    expect(node('Gross pay, 2 stubs $5,416.66')).toHaveFocus();
    expect(popover()).toHaveAccessibleName('Gross pay, 2 stubs');

    await user.keyboard('{ArrowRight}');
    expect(node('Federal tax $595.52')).toHaveFocus();
    expect(popover()).toHaveAccessibleName('Federal tax');
    await user.keyboard('{End}');
    expect(node('Take-home $3,992.08')).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(node('Flexible $249.89')).toHaveFocus();

    // Tab leaves the diagram from wherever focus is; Shift+Tab comes back to that node.
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(node('Flexible $249.89')).toHaveFocus();
  });

  it('closes on Escape and keeps focus on the node', async () => {
    const { user } = renderSankey();
    await user.click(node('Savings $300.00'));
    expect(popover()).toHaveAccessibleName('Savings');
    await user.keyboard('{Escape}');
    expect(popover()).toBeNull();
    expect(node('Savings $300.00')).toHaveFocus();
  });

  it('pins on a press and closes on a press outside', async () => {
    const { user } = renderSankey();
    await user.click(node('Savings $300.00'));
    await user.unhover(node('Savings $300.00'));
    await act(() => vi.advanceTimersByTimeAsync(GRACE_MS * 2));
    expect(popover()).toHaveAccessibleName('Savings');

    await user.click(screen.getByRole('button', { name: 'After' }));
    expect(popover()).toBeNull();
  });

  it('tells screen reader users how to move', () => {
    renderSankey();
    expect(node('Gross pay, 2 stubs $5,416.66')).toHaveAccessibleDescription(
      'Arrow keys move between amounts; each one opens its details.',
    );
  });
});
