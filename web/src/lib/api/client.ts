import createFetchClient from 'openapi-fetch';
import createQueryClient from 'openapi-react-query';
import type { paths } from './schema';

/** Base URL of the FastAPI service. Every number on screen comes from here. */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

/**
 * Typed fetch client over the generated OpenAPI schema. The bearer-token
 * middleware (Supabase JWT, one refresh on 401) is added with the data layer.
 */
export const fetchClient = createFetchClient<paths>({
  baseUrl: API_BASE_URL,
  // Resolve `fetch` per request rather than at import time, so instrumentation
  // installed later (MSW in tests, tracing in the browser) sees every call.
  fetch: (request) => globalThis.fetch(request),
});

/** TanStack Query bindings: `$api.useQuery('get', '/health')`. */
export const $api = createQueryClient(fetchClient);
