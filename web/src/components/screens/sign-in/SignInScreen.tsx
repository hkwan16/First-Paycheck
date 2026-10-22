'use client';

import type { ReactNode } from 'react';
import { CalendarIcon, LinesIcon, ShieldIcon } from '@/components/icons';
import { IconTile } from '@/components/ui/IconTile';
import { Notice } from '@/components/ui/Notice';
import type { Hue } from '@/lib/design/tone';
import { AuthForm } from './AuthForm';
import type { SignInParams } from './sign-in-params';

function Point({
  tone,
  icon,
  title,
  children,
}: {
  tone: Hue;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <IconTile tone={tone} className="-mt-1">
        {icon}
      </IconTile>
      <div>
        <strong>{title}</strong> <span className="text-ink-3">{children}</span>
      </div>
    </div>
  );
}

export type SignInScreenProps = SignInParams;

/**
 * Screen 0 of the mockup (Main.dc.html): the pitch and the sign-in form, whose
 * mode, return path and link error come from the URL (`parseSignInParams`).
 * After `DELETE /me` (`?deleted=1`) a calm notice above the form says the
 * account and its data are gone.
 */
export function SignInScreen({ mode, next, linkError, deleted }: SignInScreenProps) {
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-1 flex-wrap items-center justify-center gap-12 px-6 py-12">
      <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-6">
        <div>
          <h1 className="m-0 text-display font-bold">
            Your first month&apos;s money decisions,{' '}
            <span className="text-coral-text">with your own numbers.</span>
          </h1>
          <p className="mt-2 mb-0 text-lead text-ink-3">
            Link your accounts, upload your pay stub and benefits summary, and get a one-page plan
            for your W-4, health plan, 401(k) and emergency fund.
          </p>
        </div>
        <div className="flex flex-col gap-3.5">
          <Point tone="blue" icon={<LinesIcon />} title="Money math runs in tested code.">
            Every dollar figure comes from a calculator, never from a language model.
          </Point>
          <Point tone="coral" icon={<ShieldIcon />} title="AI reads, it does not decide.">
            It extracts fields from redacted documents, labels unknown merchants and writes
            explanations that are checked against the calculator and cite an IRS or plan source.
          </Point>
          <Point tone="teal" icon={<CalendarIcon />} title="A monthly check-in.">
            Each month it compares new pay stubs and transactions against your plan and tells you
            what changed.
          </Point>
        </div>
      </div>

      <div className="flex min-w-0 flex-[0_1_400px] flex-col gap-4">
        {deleted && (
          <Notice tone="blue" role="status">
            Your account and its data were deleted. You can create a new account at any time.
          </Notice>
        )}
        {/* A new mode starts clean: no stale notice or errors from the other form. */}
        <AuthForm key={mode} mode={mode} next={next} linkError={linkError} />
      </div>
    </div>
  );
}
