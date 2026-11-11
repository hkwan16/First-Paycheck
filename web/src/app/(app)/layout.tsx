import { Suspense, type ReactNode } from 'react';
import { AppSideNav } from '@/components/chrome/AppSideNav';
import { Header } from '@/components/chrome/Header';
import { HeaderAccount } from '@/components/chrome/HeaderAccount';
import { SessionProblemNotice } from '@/components/chrome/SessionProblemNotice';
import { Shell } from '@/components/chrome/Shell';
import { SideNav } from '@/components/chrome/SideNav';
import { TimeZoneSync } from '@/components/chrome/TimeZoneSync';
import { AuthGate } from './auth-gate';

/**
 * Signed-in screens: header, side nav and main column.
 *
 * Every runtime read sits behind Suspense so the shell prerenders: the URL
 * (for the nav's current item; the fallback is the same nav without it, so
 * nothing shifts), the user (header account chips, empty until they stream
 * in) and the session guard (the screen streams in after it). The nav's
 * done marks come from the API (AppSideNav, useSetupProgress); profile chips
 * arrive with GET /profile. TimeZoneSync saves the browser's time zone on
 * the profile when it differs, so the API's "today" is the person's.
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
      {/* Why nothing loads, when the browser cannot read its session (issue 225). */}
      <SessionProblemNotice />
      {/* The person's day is the browser's zone's (spec 019 rule 5). */}
      <TimeZoneSync />
      <Suspense fallback={null}>
        <AuthGate>{children}</AuthGate>
      </Suspense>
    </Shell>
  );
}
