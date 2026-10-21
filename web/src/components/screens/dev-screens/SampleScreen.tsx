'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Header } from '@/components/chrome/Header';
import { Shell } from '@/components/chrome/Shell';
import { SideNav, type NavKey } from '@/components/chrome/SideNav';
import { ConfirmScreen } from '@/components/screens/confirm/ConfirmScreen';
import { LinkScreen } from '@/components/screens/link/LinkScreen';
import { SpendingScreen } from '@/components/screens/spending/SpendingScreen';
import { $api } from '@/lib/api/client';
import { ACCOUNT_COUNT_LIMIT, TRANSACTIONS_PAGE_SIZE } from '@/lib/api/hooks';
import { queryKeys } from '@/lib/api/keys';
import {
  manualEntryProposal,
  PAY_STUB_DOC_ID,
  sampleBenefitsDocument,
  sampleDocument,
  sampleDocumentDetail,
} from '@/test/fixtures/documents';
import { SAMPLE_USER, sampleAccounts, sampleTransactions } from '@/test/fixtures/sample';

/*
 * A setup screen in the app frame, rendered from the mockup's sample data
 * (src/test/fixtures/sample.ts) with no API. The data is seeded into a
 * private QueryClient that never refetches, so the page is deterministic for
 * the Playwright visual baselines and the side-by-side check against the
 * mockup. Development only: the /dev/screens pages are 404 in production.
 */

export type SampleScreenName = 'link' | 'confirm' | 'confirm-manual' | 'spending';

/** The manual-entry variant's document: the same stub, which the AI declined to read. */
const MANUAL_DOC_ID = '4d000000-0000-4000-8000-0000000000aa';

const SCREENS: Record<SampleScreenName, { nav: NavKey; render: () => ReactNode }> = {
  link: { nav: 'link', render: () => <LinkScreen showSandboxLink={false} /> },
  confirm: { nav: 'confirm', render: () => <ConfirmScreen documentId={PAY_STUB_DOC_ID} /> },
  'confirm-manual': { nav: 'confirm', render: () => <ConfirmScreen documentId={MANUAL_DOC_ID} /> },
  spending: { nav: 'spending', render: () => <SpendingScreen /> },
};

function seededClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false },
      mutations: { retry: 0 },
    },
  });
  client.setQueryData(queryKeys.accounts(), [...sampleAccounts]);
  client.setQueryData(queryKeys.documents(), [sampleDocument(), sampleBenefitsDocument]);
  client.setQueryData(queryKeys.payStubs(), []);
  client.setQueryData(queryKeys.document(PAY_STUB_DOC_ID), sampleDocumentDetail());
  client.setQueryData(
    queryKeys.document(MANUAL_DOC_ID),
    sampleDocumentDetail(
      { id: MANUAL_DOC_ID, status: 'manual_entry_required', status_reason: 'refused' },
      manualEntryProposal,
    ),
  );
  client.setQueryData(queryKeys.transactionPages({ limit: TRANSACTIONS_PAGE_SIZE }), {
    pages: [{ items: [...sampleTransactions], next_cursor: null }],
    pageParams: [null],
  });
  for (const account of sampleAccounts) {
    const { queryKey } = $api.queryOptions('get', '/transactions', {
      params: { query: { account_id: account.id, limit: ACCOUNT_COUNT_LIMIT } },
    });
    client.setQueryData(queryKey, {
      items: sampleTransactions.filter((t) => t.account_id === account.id),
      next_cursor: null,
    });
  }
  return client;
}

export function SampleScreen({ screen }: { screen: SampleScreenName }) {
  const [client] = useState(seededClient);
  const { nav, render } = SCREENS[screen];
  return (
    <QueryClientProvider client={client}>
      <Shell
        header={
          <Header
            chips={[`${SAMPLE_USER.employer} · ${SAMPLE_USER.frequency}`, SAMPLE_USER.name]}
          />
        }
        nav={<SideNav current={nav} />}
      >
        {render()}
      </Shell>
    </QueryClientProvider>
  );
}
