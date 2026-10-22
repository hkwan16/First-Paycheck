import createFetchClient from 'openapi-fetch';
import createQueryClient from 'openapi-react-query';
import { hardNavigate } from '@/lib/navigation';
import { signInRoute } from '@/lib/routes';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { createAuthMiddleware, createSessionTokens } from './auth-middleware';
import { API_BASE_URL } from './base-url';
import type { paths } from './schema';

/** Typed fetch client over the generated OpenAPI schema. */
export const fetchClient = createFetchClient<paths>({
  baseUrl: API_BASE_URL,
  // Resolve `fetch` per request rather than at import time, so instrumentation
  // installed later (MSW in tests, tracing in the browser) sees every call.
  fetch: (request) => globalThis.fetch(request),
});

/**
 * The Supabase JWT, for every request to the API: the fetch middleware below
 * and the XHR upload (upload.ts) share it, and so share one refresh.
 */
export const sessionTokens = createSessionTokens({
  // Queries run in the browser only; never touch the browser client on the server.
  getAuth: () => (typeof window === 'undefined' ? null : getSupabaseBrowserClient()?.auth) ?? null,
  onSessionExpired: () =>
    hardNavigate(signInRoute({ next: `${window.location.pathname}${window.location.search}` })),
  // Nothing to return to: the sign-in screen says the account and its data were deleted.
  onAccountDeleted: () => hardNavigate(signInRoute({ deleted: true })),
});

// Bearer token on every request; one refresh and retry on 401, then sign in again;
// a 401 account_deleted signs out at once.
fetchClient.use(createAuthMiddleware(sessionTokens));

/** TanStack Query bindings: `$api.useQuery('get', '/health')`. */
export const $api = createQueryClient(fetchClient);
