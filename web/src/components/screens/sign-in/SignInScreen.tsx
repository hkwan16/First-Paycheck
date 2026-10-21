'use client';

import { Suspense, use, type ReactNode } from 'react';
import { CalendarIcon, LinesIcon, ShieldIcon } from '@/components/icons';
import { IconTile } from '@/components/ui/IconTile';
import { safeNextPath } from '@/lib/auth/next-path';
import type { Hue } from '@/lib/design/tone';
import { AuthForm } from './AuthForm';

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

export type SearchParams = Record<string, string | string[] | undefined>;

/** A query parameter given exactly once; a repeated one is ignored. */
const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : null);

/** The form, configured by `?mode=sign-up`, `?next=<path>` and `?error=link`. */
function AuthFormFromUrl({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = use(searchParams);
  const mode = single(params.mode) === 'sign-up' ? 'sign-up' : 'sign-in';
  return (
    // A new mode starts clean: no stale notice or errors from the other form.
    <AuthForm
      key={mode}
      mode={mode}
      next={safeNextPath(single(params.next))}
      linkError={single(params.error) === 'link'}
    />
  );
}

/**
 * Screen 0 of the mockup (Main.dc.html). The pitch is static; the form depends
 * on the page's `searchParams`, so it sits in Suspense (Cache Components) and
 * streams in with the right mode, with the plain sign-in form as the static
 * shell's fallback.
 */
export function SignInScreen({ searchParams }: { searchParams: Promise<SearchParams> }) {
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

      <Suspense fallback={<AuthForm mode="sign-in" next={null} linkError={false} />}>
        <AuthFormFromUrl searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
