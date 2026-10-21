import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';

/** A QueryClient for tests: no retries, so a failing request fails the test at once. */
export function makeTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

interface Options extends Omit<RenderOptions, 'wrapper'> {
  queryClient?: QueryClient;
}

/** Render with app providers and a userEvent instance bound to the document. */
export function renderWithProviders(ui: ReactElement, options: Options = {}) {
  const { queryClient = makeTestQueryClient(), ...rest } = options;
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { user: userEvent.setup(), queryClient, ...render(ui, { wrapper: Wrapper, ...rest }) };
}

export * from '@testing-library/react';
export { userEvent };
