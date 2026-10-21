import type { NextRequest } from 'next/server';
import { REQUEST_PATH_HEADER, requestPath } from '@/lib/auth/next-path';
import { requiresSignIn } from '@/lib/auth/protected';
import { signInRoute } from '@/lib/routes';
import { updateSession } from '@/lib/supabase/proxy';

/**
 * Next 16 Proxy (formerly Middleware): keeps the Supabase session fresh,
 * sends a signed-out request for a signed-in screen to /sign-in?next=<path>,
 * and tells the (app) guard which path was requested (layouts cannot read the
 * URL), overwriting any value the client sent.
 *
 * Redirecting here, before anything renders, is the main guard. The (app)
 * layout's AuthGate stays as the backstop for a token that verifies but whose
 * user is gone; a redirect thrown while rendering also stops `next dev` from
 * validating the route's instant (prefetch) UI, which it logs as an error.
 */
export async function proxy(request: NextRequest) {
  const path = requestPath(request.nextUrl);
  const session = await updateSession(request, { [REQUEST_PATH_HEADER]: path });
  if (session.signedIn === false && requiresSignIn(request.nextUrl.pathname)) {
    return session.redirectTo(new URL(signInRoute({ next: path }), request.url));
  }
  return session.response;
}

export const config = {
  // Everything except build assets, image optimization, the favicon and any
  // path whose last segment has a file extension (public/ files).
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.[^/]+$).*)'],
};
