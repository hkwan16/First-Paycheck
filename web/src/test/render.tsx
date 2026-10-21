import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, type RenderOptions } from '@testing-library/react';
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
  /** Pass `vi.advanceTimersByTime` when the test uses fake timers. */
  advanceTimers?: (ms: number) => unknown;
}

function providers(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** Render with app providers and a userEvent instance bound to the document. */
export function renderWithProviders(ui: ReactElement, options: Options = {}) {
  const { queryClient = makeTestQueryClient(), advanceTimers, ...rest } = options;
  return {
    user: userEvent.setup(advanceTimers ? { advanceTimers } : {}),
    queryClient,
    ...render(ui, { wrapper: providers(queryClient), ...rest }),
  };
}

/** renderHook inside a QueryClientProvider; returns the client for cache assertions. */
export function renderHookWithClient<Result, Props>(
  hook: (props: Props) => Result,
  options: { queryClient?: QueryClient; initialProps?: Props } = {},
) {
  const { queryClient = makeTestQueryClient(), initialProps } = options;
  return {
    queryClient,
    ...renderHook(hook, { wrapper: providers(queryClient), initialProps }),
  };
}

export * from '@testing-library/react';
export { userEvent };
