import createFetchClient from 'openapi-fetch';
import createQueryClient from 'openapi-react-query';
import { hardNavigate } from '@/lib/navigation';
import { signInRoute } from '@/lib/routes';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { createAuthMiddleware } from './auth-middleware';
import { API_BASE_URL } from './base-url';
import type { paths } from './schema';

/** Typed fetch client over the generated OpenAPI schema. */
export const fetchClient = createFetchClient<paths>({
  baseUrl: API_BASE_URL,
  // Resolve `fetch` per request rather than at import time, so instrumentation
  // installed later (MSW in tests, tracing in the browser) sees every call.
  fetch: (request) => globalThis.fetch(request),
});

// Supabase JWT as a bearer token; one refresh and retry on 401, then sign in again.
fetchClient.use(
  createAuthMiddleware({
    // Queries run in the browser only; never touch the browser client on the server.
    getAuth: () =>
      (typeof window === 'undefined' ? null : getSupabaseBrowserClient()?.auth) ?? null,
    onSessionExpired: () =>
      hardNavigate(signInRoute({ next: `${window.location.pathname}${window.location.search}` })),
  }),
);

/** TanStack Query bindings: `$api.useQuery('get', '/health')`. */
export const $api = createQueryClient(fetchClient);
