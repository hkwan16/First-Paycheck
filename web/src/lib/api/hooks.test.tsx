import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw/server';
import { apiUrl } from '@/test/msw/handlers';
import { makeTestQueryClient } from '@/test/render';
import { $api } from './client';
import { useHealth } from './hooks';

function renderHealth() {
  const queryClient = makeTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(() => useHealth(), { wrapper }) };
}

describe('useHealth', () => {
  it('reads GET /health as typed data', async () => {
    const { result } = renderHealth();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      status: 'ok',
      git_sha: 'test',
      alembic_revision: '0001_roles',
    });
  });

  it("caches under the route's $api query key", async () => {
    const { result, queryClient } = renderHealth();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { queryKey } = $api.queryOptions('get', '/health');
    expect(queryClient.getQueryData(queryKey)).toEqual(result.current.data);
  });

  it('exposes the API error shape when the service is down', async () => {
    server.use(
      http.get(apiUrl('/health'), () =>
        HttpResponse.json({ error: { code: 'unavailable', message: 'db down' } }, { status: 503 }),
      ),
    );
    const { result } = renderHealth();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual({ error: { code: 'unavailable', message: 'db down' } });
  });
});
