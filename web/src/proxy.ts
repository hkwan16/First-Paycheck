import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/proxy';

/** Next 16 Proxy (formerly Middleware): keeps the Supabase session fresh. */
export function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Everything except static assets and image optimization.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
