'use client';

import Link from 'next/link';
import type { FormEvent, ReactNode } from 'react';
import { CalendarIcon, LinesIcon, PlusCircleIcon, ShieldIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconTile } from '@/components/ui/IconTile';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import type { Hue } from '@/lib/design/tone';

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

/**
 * Screen 0 of the mockup (Main.dc.html). Static for now: the Supabase
 * password, magic-link and sign-up flows replace the no-op submit next.
 */
export function SignInScreen() {
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  };

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

      <Card
        as="form"
        padding={24}
        aria-labelledby="signin-title"
        onSubmit={onSubmit}
        className="flex-[0_1_400px]"
      >
        <h2 id="signin-title" className="m-0 text-headline tracking-[-0.012em]">
          Sign in
        </h2>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            name="password"
            autoComplete="current-password"
            placeholder="At least 12 characters"
          />
        </div>
        <Button type="submit" variant="primary" block>
          Sign in
        </Button>
        <div className="flex items-center gap-3 text-tiny tracking-[0.04em] text-ink-3 uppercase before:h-px before:flex-1 before:bg-ink/10 after:h-px after:flex-1 after:bg-ink/10">
          or
        </div>
        <Button block>
          <PlusCircleIcon className="text-ink" />
          Email me a sign-in link
        </Button>
        <p className="mt-1 mb-0 text-small text-ink-3">
          Secured by Supabase Auth. Your bank login never passes through First Paycheck; Plaid
          handles it on the next step. <Link href="/sign-in?mode=sign-up">Create an account</Link>
        </p>
      </Card>
    </div>
  );
}
