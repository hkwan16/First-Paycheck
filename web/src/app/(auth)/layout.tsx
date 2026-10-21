import type { ReactNode } from 'react';
import { Header } from '@/components/chrome/Header';

/** Signed-out pages: the header with only the wordmark. */
export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header minimal />
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
