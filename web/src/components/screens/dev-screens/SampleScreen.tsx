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
import type { Decision } from '@/lib/api/types';
import {
  SAMPLE_PERIOD,
  sampleCashflow,
  sampleRecurring,
  sampleSpendingSummary,
} from '@/test/fixtures/cashflow';
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
  BENEFITS_DOC_ID,
  manualEntryProposal,
  PAY_STUB_DOC_ID,
  sampleBenefitsDocument,
  sampleDocument,
  sampleDocumentDetail,
  samplePayStub,
} from '@/test/fixtures/documents';
import {
  sampleBenefitsPlans,
  sampleBenefitsProposal,
  sampleEmergencyDecision,
  sampleGoal,
  sampleHealthDecision,
  samplePlanningEvents,
} from '@/test/fixtures/planning';
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
  | 'link'
  | 'confirm'
  | 'confirm-manual'
  | 'confirm-benefits'
  | 'spending'
  | 'decisions'
  | 'why'
  | 'why-fallback';

/** The manual-entry variant's document: the same stub, which the AI declined to read. */
const MANUAL_DOC_ID = '4d000000-0000-4000-8000-0000000000aa';

const SEEDED_AT = Date.parse(SAMPLE_NOW);

type Seed = (queryKey: QueryKey, data: unknown) => void;

/** `GET /decisions` with each decision as its calculator's only version. */
const decisionList = (decisions: readonly Decision[]) => ({
  items: decisions.map((decision) => ({
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
  })),
});

/** After Confirm: the stub confirmed, the plan details saved and the 401(k) decision v1 at 4%. */
function seedDecided(seed: Seed) {
  const decision = sampleDecision();
  seed(queryKeys.payStubs(), [samplePayStub()]);
  seed(queryKeys.profile(), sampleProfile);
  seed(queryKeys.decisions(), decisionList([decision]));
  seed(queryKeys.decision(DECISION_V1_ID), decision);
  seed(queryKeys.calendar(), [sampleCalendarEvent()]);
  const { inputs, result } = sampleK401(4);
  seed(queryKeys.calc('/calc/401k-match', inputs), result);
}

/**
 * Every live calculator saved: the 401(k) at 4%, the emergency fund at three
 * months with its goal, and the Gold PPO from the confirmed benefits summary.
 * Each card's result is seeded under the inputs it builds from these.
 */
function seedAllDecided(seed: Seed) {
  seedDecided(seed);
  const fund = sampleEmergencyDecision();
  const health = sampleHealthDecision();
  seed(queryKeys.decisions(), decisionList([sampleDecision(), fund, health]));
  seed(queryKeys.calendar(), [sampleCalendarEvent(), ...samplePlanningEvents()]);
  seed(queryKeys.spendingSummary(), sampleSpendingSummary);
  seed(queryKeys.goals(), [sampleGoal()]);
  seed(queryKeys.benefitsPlans(), [...sampleBenefitsPlans]);
  seed(queryKeys.calc('/calc/emergency-fund', fund.inputs), fund.result);
  seed(queryKeys.calc('/calc/health-plans', health.inputs), health.result);
}

const SCREENS: Record<
  SampleScreenName,
  { nav: NavKey; render: () => ReactNode; seed?: (seed: Seed) => void }
> = {
  link: { nav: 'link', render: () => <LinkScreen showSandboxLink={false} /> },
  confirm: { nav: 'confirm', render: () => <ConfirmScreen documentId={PAY_STUB_DOC_ID} /> },
  'confirm-manual': { nav: 'confirm', render: () => <ConfirmScreen documentId={MANUAL_DOC_ID} /> },
  'confirm-benefits': {
    nav: 'confirm',
    render: () => <ConfirmScreen documentId={BENEFITS_DOC_ID} />,
  },
  spending: {
    nav: 'spending',
    render: () => <SpendingScreen showSankey initialPeriod={SAMPLE_PERIOD} />,
  },
  // Every calculator live: three saved, and the W-4 not built yet.
  decisions: {
    nav: 'decisions',
    render: () => (
      <DecisionsScreen calculators={['emergency_fund', '401k_match', 'health_plan', 'w4']} />
    ),
    seed: seedAllDecided,
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
  seed(
    queryKeys.document(BENEFITS_DOC_ID),
    sampleDocumentDetail(sampleBenefitsDocument, sampleBenefitsProposal),
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
