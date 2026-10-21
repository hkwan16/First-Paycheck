'use client';

import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
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
import { SAMPLE_PERIOD, sampleCashflow, sampleRecurring } from '@/test/fixtures/cashflow';
import {
  manualEntryProposal,
  PAY_STUB_DOC_ID,
  sampleBenefitsDocument,
  sampleDocument,
  sampleDocumentDetail,
} from '@/test/fixtures/documents';
import {
  SAMPLE_NOW,
  SAMPLE_USER,
  sampleAccounts,
  sampleTransactions,
} from '@/test/fixtures/sample';

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

const SEEDED_AT = Date.parse(SAMPLE_NOW);

const SCREENS: Record<SampleScreenName, { nav: NavKey; render: () => ReactNode }> = {
  link: { nav: 'link', render: () => <LinkScreen showSandboxLink={false} /> },
  confirm: { nav: 'confirm', render: () => <ConfirmScreen documentId={PAY_STUB_DOC_ID} /> },
  'confirm-manual': { nav: 'confirm', render: () => <ConfirmScreen documentId={MANUAL_DOC_ID} /> },
  spending: {
    nav: 'spending',
    render: () => <SpendingScreen showSankey initialPeriod={SAMPLE_PERIOD} />,
  },
};

/**
 * The sample data in a QueryClient. It never reads the clock while the page
 * renders, which `next dev` prerenders to validate the route and where a
 * Date.now() is reported as an unstable value: each entry is stamped with the
 * sample time (TanStack would stamp it with Date.now()), and `'static'` data
 * is never stale (any number, even Infinity, is compared with Date.now()).
 */
export function seededClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 'static', gcTime: Infinity, retry: false, refetchOnMount: false },
      mutations: { retry: 0 },
    },
  });
  const seed = (queryKey: QueryKey, data: unknown) =>
    client.setQueryData(queryKey, data, { updatedAt: SEEDED_AT });

  seed(queryKeys.accounts(), [...sampleAccounts]);
  seed(queryKeys.documents(), [sampleDocument(), sampleBenefitsDocument]);
  seed(queryKeys.payStubs(), []);
  seed(queryKeys.document(PAY_STUB_DOC_ID), sampleDocumentDetail());
  seed(
    queryKeys.document(MANUAL_DOC_ID),
    sampleDocumentDetail(
      { id: MANUAL_DOC_ID, status: 'manual_entry_required', status_reason: 'refused' },
      manualEntryProposal,
    ),
  );
  seed(queryKeys.transactionPages({ limit: TRANSACTIONS_PAGE_SIZE }), {
    pages: [{ items: [...sampleTransactions], next_cursor: null }],
    pageParams: [null],
  });
  const period = { params: { query: { ...SAMPLE_PERIOD } } };
  seed($api.queryOptions('get', '/cashflow', period).queryKey, sampleCashflow());
  seed(queryKeys.recurring(), [...sampleRecurring]);
  for (const account of sampleAccounts) {
    const { queryKey } = $api.queryOptions('get', '/transactions', {
      params: { query: { account_id: account.id, limit: ACCOUNT_COUNT_LIMIT } },
    });
    seed(queryKey, {
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
