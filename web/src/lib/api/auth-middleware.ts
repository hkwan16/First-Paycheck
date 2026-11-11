import type { SupabaseClient } from '@supabase/supabase-js';
import type { Middleware } from 'openapi-fetch';
import { withTimeout } from '@/lib/timeout';
import { ApiError, apiErrorCode } from './errors';

/** The slice of Supabase Auth the middleware uses. */
export type SessionAuth = Pick<SupabaseClient['auth'], 'getSession' | 'refreshSession' | 'signOut'>;

/**
 * How long a request waits for supabase-js to read (or refresh) the session
 * before it fails (issue 225). A read is local unless the access token
 * expired; then it waits on a token refresh, which supabase-js sends with no
 * timeout of its own. A healthy refresh takes well under a second.
 */
export const SESSION_READ_TIMEOUT_MS = 10_000;

export const SESSION_UNAVAILABLE_MESSAGE =
  'We could not check that you are signed in. Reload the page, or sign in again.';

/**
 * The session could not be read in time, so the request was never sent. An
 * `ApiError` with status 0 and a sentence for people, so every screen's
 * `apiErrorMessage` shows it in place of its own fallback.
 */
export class SessionUnavailable extends ApiError {
  constructor() {
    super(0, { error: { code: 'session_unavailable', message: SESSION_UNAVAILABLE_MESSAGE } });
    this.name = 'SessionUnavailable';
  }
}

export interface AuthMiddlewareOptions {
  /** Supabase Auth in the browser, or null when auth is off (tests, server rendering). */
  getAuth: () => SessionAuth | null;
  /** The API rejected the refreshed token too: the session is gone. */
  onSessionExpired: () => void;
  /**
   * The API answered 401 `account_deleted` (spec 017 rule 9): the token is
   * still valid but its account is gone, so there is nothing to refresh.
   */
  onAccountDeleted: () => void;
  /** Whether the last session read answered in time (false: `SessionUnavailable`). */
  onSessionReadable?: (readable: boolean) => void;
}

/** True for the API's 401 `account_deleted`; reads a copy, so the body stays readable. */
async function isAccountDeleted(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    return apiErrorCode(body) === 'account_deleted';
  } catch {
    return false;
  }
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
  /** Clear the local session and report the account deleted. */
  accountDeleted: () => Promise<void>;
}

export function createSessionTokens({
  getAuth,
  onSessionExpired,
  onAccountDeleted,
  onSessionReadable,
}: AuthMiddlewareOptions): SessionTokens {
  let refreshing: Promise<string | null> | null = null;

  const signOutLocally = async () => {
    const auth = getAuth();
    if (!auth) return;
    try {
      await withTimeout(auth.signOut({ scope: 'local' }), SESSION_READ_TIMEOUT_MS);
    } catch {
      // Unreachable or silent Auth: the session is unusable anyway, so sign-in is still the way out.
    }
  };

  return {
    async current() {
      const auth = getAuth();
      if (!auth) return null;
      let session: Awaited<ReturnType<SessionAuth['getSession']>>;
      try {
        session = await withTimeout(auth.getSession(), SESSION_READ_TIMEOUT_MS);
      } catch {
        onSessionReadable?.(false);
        throw new SessionUnavailable();
      }
      onSessionReadable?.(true);
      return session.data.session?.access_token ?? null;
    },

    enabled: () => getAuth() !== null,

    refreshed() {
      const auth = getAuth();
      if (!auth) return Promise.resolve(null);
      refreshing ??= withTimeout(auth.refreshSession(), SESSION_READ_TIMEOUT_MS)
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
      await signOutLocally();
      onSessionExpired();
    },

    async accountDeleted() {
      await signOutLocally();
      onAccountDeleted();
    },
  };
}

/**
 * openapi-fetch middleware for the FastAPI client. Every request carries the
 * Supabase access token as a bearer header. A 401 triggers one shared refresh
 * and one retry; a second 401, or a failed refresh, clears the local session
 * and calls `onSessionExpired`. A 401 `account_deleted`, first or after the
 * retry, clears it and calls `onAccountDeleted` instead, with no refresh.
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
      if (await isAccountDeleted(response)) {
        await tokens.accountDeleted();
        return undefined;
      }

      const token = await tokens.refreshed();
      if (token) {
        const retried = await options.fetch(withToken(copy, token));
        if (retried.status !== 401) return retried;
        if (await isAccountDeleted(retried)) await tokens.accountDeleted();
        else await tokens.expire();
        return retried;
      }
      await tokens.expire();
      return undefined;
    },
  };
}
