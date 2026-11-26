'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ArrowSmallIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { chipClasses } from '@/components/ui/Chip';
import { SIGN_OUT_PATH } from '@/lib/auth/sign-out';
import { cn } from '@/lib/cn';
import { DeleteAccountConfirm } from './DeleteAccountConfirm';

export interface UserMenuProps {
  /** The person's name or email, shown on the chip. */
  label: string;
}

/** Which item takes focus when the menu opens. */
type Opening = 'first' | 'last';

/**
 * The header's user chip as a menu button (WAI-ARIA APG menu button, issue
 * 242): it opens a small `role="menu"` with "Sign out" and, below a rule, a
 * quieter "Account" item that holds a nested menu with "Delete account"
 * (issues 205 and 267). Deleting is a step away from signing out, smaller and
 * in the destructive style, so a stray click on the open menu can at most
 * unfold the Account section, never start a deletion. The items are one Tab
 * stop: the arrow keys, Home and End move between them (through the Account
 * section while it is open), ArrowRight or Enter on Account opens the section
 * and ArrowLeft closes it, Escape closes the menu and returns to the chip, Tab
 * or a click elsewhere closes it.
 *
 * Sign out submits a form to `/auth/sign-out` (issue 224): a full navigation
 * that ends this browser's session on the server even when Supabase fails,
 * after the cached reads are dropped. Delete account closes the menu and opens
 * the `DeleteAccountConfirm` dialog.
 */
export function UserMenu({ label }: UserMenuProps) {
  const triggerId = useId();
  const menuId = useId();
  const signOutFormId = useId();
  const queryClient = useQueryClient();
  const [opening, setOpening] = useState<Opening | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = opening !== null;

  const items = () => [
    ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];

  useEffect(() => {
    if (!opening) return;
    const all = items();
    (opening === 'first' ? all[0] : all.at(-1))?.focus();
  }, [opening]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpening(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const closeToTrigger = () => {
    setOpening(null);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpening(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const focus = (index: number) => all[(index + all.length) % all.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        focus(at + 1);
        break;
      case 'ArrowUp':
        focus(at - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(all.length - 1);
        break;
      case 'Escape':
        closeToTrigger();
        break;
      case 'Tab':
        // Focus moves on as usual; the menu does not stay open behind it.
        setOpening(null);
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpening(open ? null : 'first')}
        onKeyDown={onTriggerKeyDown}
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
      {/* The menu item submits it from inside the menu (the `form` attribute). */}
      <form id={signOutFormId} method="post" action={SIGN_OUT_PATH} hidden />
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={onMenuKeyDown}
          className="absolute top-full right-0 z-20 mt-2.5 flex w-56 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-tile bg-surface p-2 shadow-pop"
        >
          <Button
            role="menuitem"
            tabIndex={-1}
            type="submit"
            form={signOutFormId}
            block
            loading={signingOut}
            onClick={() => {
              setSigningOut(true);
              // No reads of this session survive in memory, even if the page is kept for Back.
              queryClient.clear();
            }}
          >
            Sign out
          </Button>
          <hr className="m-0 border-0 border-t border-line" />
          <AccountSection
            disabled={signingOut}
            onDelete={() => {
              setOpening(null);
              setDeleting(true);
            }}
          />
        </div>
      )}
      <DeleteAccountConfirm
        open={deleting}
        onClose={() => {
          setDeleting(false);
          // The menu item that opened it is gone with the menu, so focus goes to the chip.
          triggerRef.current?.focus();
        }}
      />
    </div>
  );
}

/**
 * The menu's "Account" item and the nested menu it unfolds, holding "Delete
 * account" (issue 267). It unmounts with the menu, so it is folded again the
 * next time the menu opens. Opening it from the keyboard or a click focuses
 * Delete account, as the APG has a submenu do; ArrowLeft folds it and returns
 * to Account. Delete account is small and destructive, never the full-size
 * action Sign out is.
 */
function AccountSection({ disabled, onDelete }: { disabled: boolean; onDelete: () => void }) {
  const itemId = useId();
  const sectionId = useId();
  const [expanded, setExpanded] = useState(false);
  const itemRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);

  const focusFirst = () =>
    sectionRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();

  useEffect(() => {
    if (expanded) focusFirst();
  }, [expanded]);

  const onItemKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowRight') return;
    event.preventDefault();
    if (expanded) focusFirst();
    else setExpanded(true);
  };

  const onSectionKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowLeft') return;
    event.preventDefault();
    setExpanded(false);
    itemRef.current?.focus();
  };

  return (
    <>
      <button
        ref={itemRef}
        id={itemId}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-controls={expanded ? sectionId : undefined}
        disabled={disabled}
        onClick={() => setExpanded((was) => !was)}
        onKeyDown={onItemKeyDown}
        className={cn(
          'flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-control border-0 bg-transparent px-3',
          'text-small font-medium text-ink-2 hover:bg-fill hover:text-ink',
          'disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:bg-transparent',
        )}
      >
        Account
        <ArrowSmallIcon
          size={8}
          className={cn(
            'transition-[rotate] duration-(--duration-fast)',
            expanded ? 'rotate-90' : 'rotate-0',
          )}
        />
      </button>
      {expanded && (
        <div
          ref={sectionRef}
          id={sectionId}
          role="menu"
          aria-labelledby={itemId}
          onKeyDown={onSectionKeyDown}
          className="flex flex-col"
        >
          <Button
            role="menuitem"
            tabIndex={-1}
            variant="destructive"
            size="sm"
            block
            disabled={disabled}
            onClick={onDelete}
          >
            Delete account
          </Button>
        </div>
      )}
    </>
  );
}
