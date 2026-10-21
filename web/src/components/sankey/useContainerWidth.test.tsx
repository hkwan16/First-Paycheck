import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@/test/render';
import { SSR_WIDTH, useContainerWidth } from './useContainerWidth';

function Probe() {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="box">
      {width}
    </div>
  );
}

/** A ResizeObserver the test can fire; jsdom has none. */
function installResizeObserver() {
  const observers: {
    callback: ResizeObserverCallback;
    targets: Element[];
    disconnected: boolean;
  }[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [], disconnected: false };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
  return {
    observers,
    resize(target: Element, width: number) {
      Object.defineProperty(target, 'clientWidth', { configurable: true, value: width });
      for (const o of observers) {
        if (!o.disconnected && o.targets.includes(target)) {
          o.callback([], {} as ResizeObserver);
        }
      }
    },
  };
}

describe('useContainerWidth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts at the server width, the main column at 1280', () => {
    expect(SSR_WIDTH).toBe(928);
  });

  it('measures the element once mounted and follows its resizes, in whole pixels', () => {
    const ro = installResizeObserver();
    const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(712.6);
    render(<Probe />);
    spy.mockRestore();
    const box = screen.getByTestId('box');
    expect(box).toHaveTextContent('712');

    act(() => ro.resize(box, 350));
    expect(box).toHaveTextContent('350');
  });

  it('ignores a zero width (not laid out yet) and stops observing on unmount', () => {
    const ro = installResizeObserver();
    const { unmount } = render(<Probe />);
    const box = screen.getByTestId('box');
    act(() => ro.resize(box, 0));
    expect(box).toHaveTextContent(String(SSR_WIDTH));
    unmount();
    expect(ro.observers.every((o) => o.disconnected)).toBe(true);
  });

  it('measures once where ResizeObserver does not exist', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    render(<Probe />);
    spy.mockRestore();
    expect(screen.getByTestId('box')).toHaveTextContent('600');
  });
});
