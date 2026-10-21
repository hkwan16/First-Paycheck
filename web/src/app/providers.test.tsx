import { useQueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Providers } from './providers';

function Probe() {
  const client = useQueryClient();
  return <p>stale {String(client.getDefaultOptions().queries?.staleTime)}</p>;
}

describe('Providers', () => {
  it('provides the app QueryClient to its children', () => {
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    expect(screen.getByText('stale 30000')).toBeInTheDocument();
  });

  it('keeps the same client across re-renders', () => {
    const seen = new Set<unknown>();
    function Capture() {
      seen.add(useQueryClient());
      return null;
    }
    const { rerender } = render(
      <Providers>
        <Capture />
      </Providers>,
    );
    rerender(
      <Providers>
        <Capture />
      </Providers>,
    );
    expect(seen.size).toBe(1);
  });
});
