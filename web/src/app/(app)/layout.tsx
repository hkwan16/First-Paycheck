import { Suspense, type ReactNode } from 'react';
import { AppSideNav } from '@/components/chrome/AppSideNav';
import { Header } from '@/components/chrome/Header';
import { HeaderAccount } from '@/components/chrome/HeaderAccount';
import { Shell } from '@/components/chrome/Shell';
import { SideNav } from '@/components/chrome/SideNav';
import { AuthGate } from './auth-gate';

/**
 * Signed-in screens: header, side nav and main column.
 *
 * Every runtime read sits behind Suspense so the shell prerenders: the URL
 * (for the nav's current item; the fallback is the same nav without it, so
 * nothing shifts), the user (header account chips, empty until they stream
 * in) and the session guard (the screen streams in after it). The nav's
 * done marks come from the API (AppSideNav, useSetupProgress); profile chips
 * arrive with GET /profile.
 */
export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Shell
      header={
        <Header
          account={
            <Suspense fallback={null}>
              <HeaderAccount />
            </Suspense>
          }
        />
      }
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
