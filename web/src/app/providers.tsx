'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useState, type ReactNode } from 'react';
import { features } from '@/lib/features';
import { makeQueryClient } from '@/lib/query-client';

// Devtools only in development, and never under test automation (screenshots).
const showDevtools = process.env.NODE_ENV === 'development' && !features.e2e;

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser session; useState keeps it across re-renders.
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {showDevtools && <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />}
    </QueryClientProvider>
  );
}
