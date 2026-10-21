import type { SupabaseClient } from '@supabase/supabase-js';
import type { Middleware } from 'openapi-fetch';

/** The slice of Supabase Auth the middleware uses. */
export type SessionAuth = Pick<SupabaseClient['auth'], 'getSession' | 'refreshSession' | 'signOut'>;

export interface AuthMiddlewareOptions {
  /** Supabase Auth in the browser, or null when auth is off (tests, server rendering). */
  getAuth: () => SessionAuth | null;
  /** The API rejected the refreshed token too: the session is gone. */
  onSessionExpired: () => void;
}

function withToken(request: Request, token: string): Request {
  const authed = new Request(request);
  authed.headers.set('Authorization', `Bearer ${token}`);
  return authed;
}

/**
 * openapi-fetch middleware for the FastAPI client. Every request carries the
 * Supabase access token as a bearer header. A 401 triggers one
 * `refreshSession()` (shared by requests that fail together, since refresh
 * tokens are single-use) and one retry; a second 401, or a failed refresh,
 * clears the local session and calls `onSessionExpired`.
 */
export function createAuthMiddleware({
  getAuth,
  onSessionExpired,
}: AuthMiddlewareOptions): Middleware {
  // The body of a sent Request is consumed, so each request keeps an unsent copy for the retry.
  const retryCopies = new WeakMap<Request, Request>();
  let refreshing: Promise<string | null> | null = null;

  const refreshedToken = (auth: SessionAuth) => {
    refreshing ??= auth
      .refreshSession()
      .then(
        ({ data, error }) => (error ? null : (data.session?.access_token ?? null)),
        () => null,
      )
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  const expire = async (auth: SessionAuth) => {
    try {
      await auth.signOut({ scope: 'local' });
    } catch {
      // Unreachable Auth: the session is unusable anyway, so sign-in is still the way out.
    }
    onSessionExpired();
  };

  return {
    async onRequest({ request }) {
      const auth = getAuth();
      if (!auth) return undefined;
      const { data } = await auth.getSession();
      const token = data.session?.access_token;
      const sent = token ? withToken(request, token) : request;
      retryCopies.set(sent, sent.clone());
      return sent;
    },

    async onResponse({ request, response, options }) {
      if (response.status !== 401) return undefined;
      const auth = getAuth();
      const copy = retryCopies.get(request);
      retryCopies.delete(request);
      if (!auth || !copy) return undefined;

      const token = await refreshedToken(auth);
      if (token) {
        const retried = await options.fetch(withToken(copy, token));
        if (retried.status !== 401) return retried;
        await expire(auth);
        return retried;
      }
      await expire(auth);
      return undefined;
    },
  };
}
