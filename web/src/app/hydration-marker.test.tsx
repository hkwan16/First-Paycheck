import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HydrationMarker } from './hydration-marker';

describe('HydrationMarker', () => {
  afterEach(() => {
    delete document.documentElement.dataset.hydrated;
  });

  it('marks <html> once React has hydrated, so tests can wait for an interactive page', () => {
    expect(document.documentElement).not.toHaveAttribute('data-hydrated');
    const { container } = render(<HydrationMarker />);
    expect(document.documentElement).toHaveAttribute('data-hydrated', 'true');
    expect(container).toBeEmptyDOMElement();
  });
});

describe('every page', () => {
  // Pages that never render (they only redirect) have nothing to hydrate.
  const REDIRECT_ONLY = ['./page.tsx'];
  const pages = import.meta.glob<string>('./**/page.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('renders the marker itself, so it fires when the page content hydrates', () => {
    // The App Router hydrates each segment in its own commit: a marker in the
    // root layout fired before the page below it was interactive, and Playwright
    // then touched dehydrated inputs (a hydration mismatch in CI).
    expect(Object.keys(pages).length).toBeGreaterThan(5);
    for (const [path, source] of Object.entries(pages)) {
      if (REDIRECT_ONLY.includes(path)) continue;
      expect(source, path).toContain('<HydrationMarker />');
    }
  });

  it('is not in the root layout, where it would fire too early', () => {
    const [layout] = Object.values(
      import.meta.glob<string>('./layout.tsx', { query: '?raw', import: 'default', eager: true }),
    );
    expect(layout).toBeDefined();
    expect(layout).not.toContain('HydrationMarker');
  });
});
