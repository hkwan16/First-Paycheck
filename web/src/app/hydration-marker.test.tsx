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
