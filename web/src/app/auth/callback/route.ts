import { NextResponse, type NextRequest } from 'next/server';
import { safeNextPath } from '@/lib/auth/next-path';
import { signInRoute } from '@/lib/routes';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Where magic links and sign-up confirmations land (PKCE flow): exchange the
 * one-time code for a session cookie, then go to `next` when it is a safe
 * relative path, or home. A missing, expired or already used code (or a link
 * opened in a different browser than the one that asked for it) goes back to
 * sign in with `?error=link`.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const next = safeNextPath(request.nextUrl.searchParams.get('next'));

  if (code && (await exchange(code))) {
    return NextResponse.redirect(new URL(next ?? '/', request.url));
  }
  return NextResponse.redirect(new URL(signInRoute({ next, error: 'link' }), request.url));
}

async function exchange(code: string): Promise<boolean> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return false;
  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return !error;
  } catch {
    return false;
  }
}
