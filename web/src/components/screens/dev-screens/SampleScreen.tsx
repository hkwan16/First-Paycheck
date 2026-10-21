'use client';

import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Header } from '@/components/chrome/Header';
import { Shell } from '@/components/chrome/Shell';
import { SideNav, type NavKey } from '@/components/chrome/SideNav';
import { ConfirmScreen } from '@/components/screens/confirm/ConfirmScreen';
import { DecisionsScreen } from '@/components/screens/decisions/DecisionsScreen';
import { LinkScreen } from '@/components/screens/link/LinkScreen';
import { SpendingScreen } from '@/components/screens/spending/SpendingScreen';
import { WhyScreen } from '@/components/screens/why/WhyScreen';
import { $api } from '@/lib/api/client';
import { ACCOUNT_COUNT_LIMIT, TRANSACTIONS_PAGE_SIZE } from '@/lib/api/hooks';
import { queryKeys } from '@/lib/api/keys';
import {
  DECISION_V1_ID,
  sampleCalendarEvent,
  sampleDecision,
  sampleExplanation,
  sampleFallbackExplanation,
  sampleK401,
  sampleProfile,
} from '@/test/fixtures/decisions';
import {
  manualEntryProposal,
  PAY_STUB_DOC_ID,
  sampleBenefitsDocument,
  sampleDocument,
  sampleDocumentDetail,
  samplePayStub,
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

export type SampleScreenName =
  'link' | 'confirm' | 'confirm-manual' | 'spending' | 'decisions' | 'why' | 'why-fallback';

/** The manual-entry variant's document: the same stub, which the AI declined to read. */
const MANUAL_DOC_ID = '4d000000-0000-4000-8000-0000000000aa';

const SEEDED_AT = Date.parse(SAMPLE_NOW);

type Seed = (queryKey: QueryKey, data: unknown) => void;

/** After Confirm: the stub confirmed, the plan details saved and the 401(k) decision v1 at 4%. */
function seedDecided(seed: Seed) {
  const decision = sampleDecision();
  seed(queryKeys.payStubs(), [samplePayStub()]);
  seed(queryKeys.profile(), sampleProfile);
  seed(queryKeys.decisions(), {
    items: [
      {
        calculator: decision.calculator,
        current: decision,
        versions: [
          {
            id: decision.id,
            version: decision.version,
            supersedes_id: null,
            created_at: decision.created_at,
          },
        ],
      },
    ],
  });
  seed(queryKeys.decision(DECISION_V1_ID), decision);
  seed(queryKeys.calendar(), [sampleCalendarEvent()]);
  const { inputs, result } = sampleK401(4);
  seed(queryKeys.calc('/calc/401k-match', inputs), result);
}

const SCREENS: Record<
  SampleScreenName,
  { nav: NavKey; render: () => ReactNode; seed?: (seed: Seed) => void }
> = {
  link: { nav: 'link', render: () => <LinkScreen showSandboxLink={false} /> },
  confirm: { nav: 'confirm', render: () => <ConfirmScreen documentId={PAY_STUB_DOC_ID} /> },
  'confirm-manual': { nav: 'confirm', render: () => <ConfirmScreen documentId={MANUAL_DOC_ID} /> },
  spending: { nav: 'spending', render: () => <SpendingScreen /> },
  // The alpha build: only the 401(k) calculator is live.
  decisions: {
    nav: 'decisions',
    render: () => <DecisionsScreen calculators={['401k_match']} />,
    seed: seedDecided,
  },
  why: {
    nav: 'why',
    render: () => <WhyScreen decisionId={DECISION_V1_ID} />,
    seed: (seed) => {
      seedDecided(seed);
      seed(queryKeys.explanation(DECISION_V1_ID), sampleExplanation());
    },
  },
  'why-fallback': {
    nav: 'why',
    render: () => <WhyScreen decisionId={DECISION_V1_ID} />,
    seed: (seed) => {
      seedDecided(seed);
      seed(queryKeys.explanation(DECISION_V1_ID), sampleFallbackExplanation());
    },
  },
};

/**
 * The sample data in a QueryClient. It never reads the clock while the page
 * renders, which `next dev` prerenders to validate the route and where a
 * Date.now() is reported as an unstable value: each entry is stamped with the
 * sample time (TanStack would stamp it with Date.now()), and `'static'` data
 * is never stale (any number, even Infinity, is compared with Date.now()).
 */
export function seededClient(screen: SampleScreenName = 'link') {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 'static', gcTime: Infinity, retry: false, refetchOnMount: false },
      mutations: { retry: 0 },
    },
  });
  const seed: Seed = (queryKey, data) =>
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
  for (const account of sampleAccounts) {
    const { queryKey } = $api.queryOptions('get', '/transactions', {
      params: { query: { account_id: account.id, limit: ACCOUNT_COUNT_LIMIT } },
    });
    seed(queryKey, {
      items: sampleTransactions.filter((t) => t.account_id === account.id),
      next_cursor: null,
    });
  }
  SCREENS[screen].seed?.(seed);
  return client;
}

export function SampleScreen({ screen }: { screen: SampleScreenName }) {
  const [client] = useState(() => seededClient(screen));
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
