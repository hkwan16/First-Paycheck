import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw/server';
import { apiUrl } from '@/test/msw/handlers';
import { fetchClient } from './client';

describe('fetchClient', () => {
  it('reads GET /health through the typed client', async () => {
    const { data, error } = await fetchClient.GET('/health');
    expect(error).toBeUndefined();
    expect(data).toEqual({ status: 'ok', git_sha: 'test', alembic_revision: '0001_roles' });
  });

  it('surfaces the API error shape instead of throwing', async () => {
    server.use(
      http.get(apiUrl('/health'), () =>
        HttpResponse.json({ error: { code: 'unavailable', message: 'db down' } }, { status: 503 }),
      ),
    );
    const { data, error, response } = await fetchClient.GET('/health');
    expect(data).toBeUndefined();
    expect(response.status).toBe(503);
    expect(error).toEqual({ error: { code: 'unavailable', message: 'db down' } });
  });
});
