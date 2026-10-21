import { Suspense, type ReactNode } from 'react';
import { AppSideNav } from '@/components/chrome/AppSideNav';
import { Header } from '@/components/chrome/Header';
import { Shell } from '@/components/chrome/Shell';
import { SideNav } from '@/components/chrome/SideNav';
import { AuthGate } from './auth-gate';

/**
 * Signed-in screens: header, side nav and main column.
 *
 * Both runtime reads sit behind Suspense so the shell prerenders: the URL
 * (for the nav's current item; the fallback is the same nav without it, so
 * nothing shifts) and the session (the screen streams in after the guard).
 * Header chips and done marks come from the profile and setup progress once
 * the data layer lands.
 */
export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Shell
      header={<Header />}
      nav={
        <Suspense fallback={<SideNav />}>
          <AppSideNav />
        </Suspense>
      }
    >
      <Suspense fallback={null}>
        <AuthGate>{children}</AuthGate>
      </Suspense>
    </Shell>
  );
}
