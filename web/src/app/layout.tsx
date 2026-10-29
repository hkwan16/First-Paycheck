import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SITE_NAME, TITLE_TEMPLATE } from '@/lib/page-title';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: SITE_NAME, template: TITLE_TEMPLATE },
  description: "Your first month's money decisions, with your own numbers.",
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
