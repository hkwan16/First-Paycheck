'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowSmallIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { chipClasses } from '@/components/ui/Chip';
import { cn } from '@/lib/cn';
import { hardNavigate } from '@/lib/navigation';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';

export interface UserMenuProps {
  /** The person's name or email, shown on the chip. */
  label: string;
}

/**
 * The header's user chip as a disclosure button: it opens a small panel with
 * "Sign out". Escape or a click elsewhere closes it. Sign-out ends only this
 * browser's session, then fully navigates to /sign-in so no state from the
 * session survives.
 */
export function UserMenu({ label }: UserMenuProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const signOut = async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return hardNavigate('/sign-in');
    setSigningOut(true);
    setError(null);
    // 'local' ends this browser's session and leaves the person's other devices signed in.
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
    if (signOutError) {
      setSigningOut(false);
      setError('We could not sign you out. Check your connection and try again.');
      return;
    }
    hardNavigate('/sign-in'); // Stay busy while the page unloads.
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          chipClasses,
          // The chip stays 26px tall; the invisible ::after grows the target to 44px.
          'relative cursor-pointer border-0 after:absolute after:inset-x-0 after:-inset-y-[9px] hover:bg-fill-strong',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue',
        )}
      >
        {label}
        <ArrowSmallIcon
          size={8}
          className={cn(
            'transition-[rotate] duration-(--duration-fast)',
            open ? '-rotate-90' : 'rotate-90',
          )}
        />
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute top-full right-0 z-20 mt-2.5 flex w-56 flex-col gap-2 rounded-tile bg-surface p-2 shadow-pop"
      >
        {open && (
          <>
            <Button block loading={signingOut} onClick={signOut}>
              Sign out
            </Button>
            {error && (
              <p role="alert" className="m-0 px-1 text-small text-ink-2">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
