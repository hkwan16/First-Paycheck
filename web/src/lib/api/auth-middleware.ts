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
 * The bearer token for API calls, shared by every transport: the fetch
 * middleware below and the XHR upload (`upload.ts`). One `refreshSession()`
 * is shared by every caller that fails together, since refresh tokens are
 * single-use.
 */
export interface SessionTokens {
  /** The current access token, or null when auth is off or there is no session. */
  current: () => Promise<string | null>;
  /** True when auth is on: a 401 is worth one refresh. */
  enabled: () => boolean;
  /** A refreshed access token, or null when the refresh failed. */
  refreshed: () => Promise<string | null>;
  /** Clear the local session and report it gone. */
  expire: () => Promise<void>;
}

export function createSessionTokens({
  getAuth,
  onSessionExpired,
}: AuthMiddlewareOptions): SessionTokens {
  let refreshing: Promise<string | null> | null = null;

  return {
    async current() {
      const auth = getAuth();
      if (!auth) return null;
      const { data } = await auth.getSession();
      return data.session?.access_token ?? null;
    },

    enabled: () => getAuth() !== null,

    refreshed() {
      const auth = getAuth();
      if (!auth) return Promise.resolve(null);
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
    },

    async expire() {
      const auth = getAuth();
      try {
        await auth?.signOut({ scope: 'local' });
      } catch {
        // Unreachable Auth: the session is unusable anyway, so sign-in is still the way out.
      }
      onSessionExpired();
    },
  };
}

/**
 * openapi-fetch middleware for the FastAPI client. Every request carries the
 * Supabase access token as a bearer header. A 401 triggers one shared refresh
 * and one retry; a second 401, or a failed refresh, clears the local session
 * and calls `onSessionExpired`.
 */
export function createAuthMiddleware(tokens: SessionTokens): Middleware {
  // The body of a sent Request is consumed, so each request keeps an unsent copy for the retry.
  const retryCopies = new WeakMap<Request, Request>();

  return {
    async onRequest({ request }) {
      if (!tokens.enabled()) return undefined;
      const token = await tokens.current();
      const sent = token ? withToken(request, token) : request;
      retryCopies.set(sent, sent.clone());
      return sent;
    },

    async onResponse({ request, response, options }) {
      if (response.status !== 401) return undefined;
      const copy = retryCopies.get(request);
      retryCopies.delete(request);
      if (!tokens.enabled() || !copy) return undefined;

      const token = await tokens.refreshed();
      if (token) {
        const retried = await options.fetch(withToken(copy, token));
        if (retried.status !== 401) return retried;
        await tokens.expire();
        return retried;
      }
      await tokens.expire();
      return undefined;
    },
  };
}
