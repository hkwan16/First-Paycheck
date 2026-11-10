import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Header } from '@/components/chrome/Header';
import { HeaderAccount } from '@/components/chrome/HeaderAccount';
import { PageTitle } from '@/components/chrome/PageTitle';
import { Button } from '@/components/ui/Button';
import { HydrationMarker } from './hydration-marker';

export const metadata: Metadata = { title: 'Page not found' };

/**
 * Any address with no page (issue 237), in the app's header, which keeps a
 * signed-in person's account menu (it reads the session, so it streams in).
 * There is no side nav: a signed-out visitor sees this too. The way back is
 * `/`, which sends each of them to the right start (setup or sign in).
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header
        account={
          <Suspense fallback={null}>
            <HeaderAccount />
          </Suspense>
        }
      />
      <main className="mx-auto flex w-full max-w-[1280px] flex-col items-start gap-6 p-6">
        <PageTitle
          title="Page not found"
          lead="There is nothing at this address. The link may be mistyped, or the page may have moved."
        />
        <Button href="/" variant="primary">
          Go to First Paycheck
        </Button>
      </main>
      <HydrationMarker />
    </div>
  );
}
