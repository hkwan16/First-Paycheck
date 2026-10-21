import type { NextRequest } from 'next/server';
import { REQUEST_PATH_HEADER, requestPath } from '@/lib/auth/next-path';
import { updateSession } from '@/lib/supabase/proxy';

/**
 * Next 16 Proxy (formerly Middleware): keeps the Supabase session fresh and
 * tells the (app) guard which path was requested (layouts cannot read the
 * URL), overwriting any value the client sent.
 */
export function proxy(request: NextRequest) {
  return updateSession(request, { [REQUEST_PATH_HEADER]: requestPath(request.nextUrl) });
}

export const config = {
  // Everything except build assets, image optimization, the favicon and any
  // path whose last segment has a file extension (public/ files).
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.[^/]+$).*)'],
};
