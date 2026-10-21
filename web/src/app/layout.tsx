import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { HydrationMarker } from './hydration-marker';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'First Paycheck', template: '%s | First Paycheck' },
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
        <HydrationMarker />
      </body>
    </html>
  );
}
