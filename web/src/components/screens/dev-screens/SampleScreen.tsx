'use client';

import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import type { Route } from 'next';
import { useState, type ReactNode } from 'react';
import { Header } from '@/components/chrome/Header';
import { Shell } from '@/components/chrome/Shell';
import { UserMenu } from '@/components/chrome/UserMenu';
import { SideNav, type NavKey } from '@/components/chrome/SideNav';
import { CheckInIndexScreen } from '@/components/screens/check-in/CheckInIndexScreen';
import { CheckInScreen } from '@/components/screens/check-in/CheckInScreen';
import { checkInWindow } from '@/components/screens/check-in/checkin-format';
import { NET_WORTH_MONTHS } from '@/components/screens/check-in/NetWorthCard';
import { ConfirmScreen } from '@/components/screens/confirm/ConfirmScreen';
import { DecisionStepScreen } from '@/components/screens/decisions/DecisionStepScreen';
import { LinkScreen } from '@/components/screens/link/LinkScreen';
import { PlanScreen } from '@/components/screens/plan/PlanScreen';
import { SpendingScreen } from '@/components/screens/spending/SpendingScreen';
import { WhyIndexScreen } from '@/components/screens/why/WhyIndexScreen';
import { WhyScreen } from '@/components/screens/why/WhyScreen';
import { $api } from '@/lib/api/client';
import { ACCOUNT_COUNT_LIMIT, TRANSACTIONS_PAGE_SIZE } from '@/lib/api/hooks';
import { queryKeys } from '@/lib/api/keys';
import type { CheckInDetail, Decision } from '@/lib/api/types';
import { CALCULATORS, type CalculatorId } from '@/lib/features';
import { checkInRoute } from '@/lib/routes';
import type { SetupProgress } from '@/lib/setup-progress';
import {
  SAMPLE_PERIOD,
  sampleCashflow,
  sampleRecurring,
  sampleSpendingSummary,
} from '@/test/fixtures/cashflow';
import {
  completedNovemberCheckIn,
  NOVEMBER_ID,
  NOVEMBER_PERIOD,
  novemberCalendar,
  novemberCheckIn,
  octoberCheckIn,
  sampleHoldings,
  sampleNetWorth,
  summaryOf,
} from '@/test/fixtures/checkins';
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
import { emptyPlan, samplePlan } from '@/test/fixtures/plan';
import { sampleW4Decision, sampleW4Event } from '@/test/fixtures/w4';

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
  | 'confirm-unread'
  | 'confirm-benefits'
  | 'confirm-extracting'
  | 'confirm-failed'
  | 'confirm-confirmed'
  | 'account'
  | 'spending'
  | 'decisions-emergency-fund'
  | 'decisions-401k'
  | 'decisions-health-plan'
  | 'decisions-w4'
  | 'decisions-after-alpha'
  | 'why'
  | 'why-fallback'
  | 'why-stale'
  | 'why-index'
  | 'check-in'
  | 'check-in-complete'
  | 'check-in-index'
  | 'plan'
  | 'plan-empty';

/** The manual-entry variant's document: the same stub, which the AI declined to read. */
const MANUAL_DOC_ID = '4d000000-0000-4000-8000-0000000000aa';
/** The same stub uploaded while the AI was unavailable, which can be read again (issue 163). */
const UNREAD_DOC_ID = '4d000000-0000-4000-8000-0000000000ae';
/** The same stub while it is read, after it failed to open, and once confirmed. */
const EXTRACTING_DOC_ID = '4d000000-0000-4000-8000-0000000000ab';
const FAILED_DOC_ID = '4d000000-0000-4000-8000-0000000000ac';
const CONFIRMED_DOC_ID = '4d000000-0000-4000-8000-0000000000ad';

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
  seed(queryKeys.calc('/calc/401k-match', inputs), { inputs, result });
}

/**
 * Every calculator saved: the 401(k) at 4%, the emergency fund at three
 * months with its goal, the Gold PPO from the confirmed benefits summary, and
 * the W-4 reading those two. Each card's result is seeded under the inputs it
 * builds from these.
 */
function seedAllDecided(seed: Seed) {
  seedDecided(seed);
  const fund = sampleEmergencyDecision();
  const health = sampleHealthDecision();
  const w4 = sampleW4Decision();
  seed(queryKeys.decisions(), decisionList([sampleDecision(), fund, health, w4]));
  // Upcoming events in `GET /calendar` order: by due date.
  seed(queryKeys.calendar(), [sampleCalendarEvent(), sampleW4Event(), ...samplePlanningEvents()]);
  seed(queryKeys.spendingSummary(), sampleSpendingSummary);
  seed(queryKeys.goals(), [sampleGoal()]);
  seed(queryKeys.benefitsPlans(), [...sampleBenefitsPlans]);
  seed(queryKeys.calc('/calc/emergency-fund', fund.inputs), {
    inputs: fund.inputs,
    result: fund.result,
  });
  seed(queryKeys.calc('/calc/health-plans', health.inputs), {
    inputs: health.inputs,
    result: health.result,
  });
  seed(queryKeys.calc('/calc/w4', w4.inputs), { inputs: w4.inputs, result: w4.result });
}

/** Spec 015's November user, a month after the decisions: one check-in open (or done), October's done. */
function seedCheckIns(seed: Seed, november: CheckInDetail) {
  seed(queryKeys.checkIns(), [summaryOf(november), summaryOf(octoberCheckIn())]);
  seed(queryKeys.checkIn(NOVEMBER_ID), november);
  const { queryKey } = $api.queryOptions('get', '/calendar', {
    params: { query: checkInWindow(NOVEMBER_PERIOD) },
  });
  seed(queryKey, novemberCalendar());
  seed(
    $api.queryOptions('get', '/net-worth', { params: { query: { months: NET_WORTH_MONTHS } } })
      .queryKey,
    sampleNetWorth(),
  );
  seed(queryKeys.holdings(), sampleHoldings());
}

const CHECK_IN_HREFS = { checkIn: checkInRoute(NOVEMBER_ID) };

const ALPHA: readonly CalculatorId[] = ['401k_match'];

/** Every saved decision's step done, and Decisions with them. */
const ALL_DECIDED: Partial<SetupProgress> = {
  decisions: true,
  ...Object.fromEntries(CALCULATORS.map((id) => [id, true])),
};

/** A decision step with every calculator live and saved. */
const decisionStep = (calculator: CalculatorId) => ({
  nav: calculator,
  render: () => <DecisionStepScreen calculator={calculator} calculators={CALCULATORS} />,
  seed: seedAllDecided,
  done: ALL_DECIDED,
});

const SCREENS: Record<
  SampleScreenName,
  {
    nav: NavKey;
    render: () => ReactNode;
    /** The header's account menu (UserMenu) in place of the person's name chip. */
    accountMenu?: boolean;
    seed?: (seed: Seed) => void;
    /** Id-bound nav links, as AppSideNav gives them from API data. */
    hrefs?: Partial<Record<NavKey, Route>>;
    /** Done marks, as AppSideNav reads them from API data. */
    done?: Partial<SetupProgress>;
    /** Live calculators, for the nav's decision steps; every one unless given. */
    calculators?: readonly CalculatorId[];
  }
> = {
  link: { nav: 'link', render: () => <LinkScreen showSandboxLink={false} /> },
  // The Link screen with the header's account menu, for the account deletion flow.
  account: {
    nav: 'link',
    render: () => <LinkScreen showSandboxLink={false} />,
    accountMenu: true,
  },
  confirm: { nav: 'confirm', render: () => <ConfirmScreen documentId={PAY_STUB_DOC_ID} /> },
  'confirm-manual': { nav: 'confirm', render: () => <ConfirmScreen documentId={MANUAL_DOC_ID} /> },
  'confirm-unread': { nav: 'confirm', render: () => <ConfirmScreen documentId={UNREAD_DOC_ID} /> },
  'confirm-benefits': {
    nav: 'confirm',
    render: () => <ConfirmScreen documentId={BENEFITS_DOC_ID} />,
  },
  'confirm-extracting': {
    nav: 'confirm',
    render: () => <ConfirmScreen documentId={EXTRACTING_DOC_ID} />,
  },
  'confirm-failed': { nav: 'confirm', render: () => <ConfirmScreen documentId={FAILED_DOC_ID} /> },
  'confirm-confirmed': {
    nav: 'confirm',
    render: () => <ConfirmScreen documentId={CONFIRMED_DOC_ID} />,
  },
  spending: {
    nav: 'spending',
    render: () => <SpendingScreen showSankey initialPeriod={SAMPLE_PERIOD} />,
  },
  // Every calculator live and saved: one sample per step.
  'decisions-emergency-fund': decisionStep('emergency_fund'),
  'decisions-401k': decisionStep('401k_match'),
  'decisions-health-plan': decisionStep('health_plan'),
  'decisions-w4': decisionStep('w4'),
  // The alpha (calculators=401k_match) with its 401(k) saved: a step that is off.
  'decisions-after-alpha': {
    nav: 'emergency_fund',
    render: () => <DecisionStepScreen calculator="emergency_fund" calculators={ALPHA} />,
    seed: seedDecided,
    done: { '401k_match': true, decisions: true },
    calculators: ALPHA,
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
  // Issue 161: verified, but written from figures that have changed since.
  'why-stale': {
    nav: 'why',
    render: () => <WhyScreen decisionId={DECISION_V1_ID} />,
    seed: (seed) => {
      seedDecided(seed);
      seed(queryKeys.explanation(DECISION_V1_ID), sampleExplanation({ stale: true }));
    },
  },
  'why-index': { nav: 'why', render: () => <WhyIndexScreen />, seed: seedDecided },
  'check-in': {
    nav: 'checkIn',
    render: () => <CheckInScreen checkInId={NOVEMBER_ID} />,
    seed: (seed) => seedCheckIns(seed, novemberCheckIn()),
    hrefs: CHECK_IN_HREFS,
  },
  'check-in-complete': {
    nav: 'checkIn',
    render: () => <CheckInScreen checkInId={NOVEMBER_ID} />,
    seed: (seed) => seedCheckIns(seed, completedNovemberCheckIn()),
    hrefs: CHECK_IN_HREFS,
  },
  'check-in-index': {
    nav: 'checkIn',
    render: () => <CheckInIndexScreen />,
    seed: (seed) => seedCheckIns(seed, novemberCheckIn()),
    hrefs: CHECK_IN_HREFS,
  },
  // Every decision saved: the same decisions, goal, dates and pay stub as the other samples.
  plan: {
    nav: 'plan',
    render: () => <PlanScreen />,
    seed: (seed) => seed(queryKeys.plan(), samplePlan()),
  },
  'plan-empty': {
    nav: 'plan',
    render: () => <PlanScreen />,
    seed: (seed) => seed(queryKeys.plan(), emptyPlan()),
  },
};

/**
 * The sample data in a QueryClient. It never reads the clock while the page
 * renders, which `next dev` prerenders to validate the route and where a
 * Date.now() is reported as an unstable value: each entry is stamped with the
 * sample time (TanStack would stamp it with Date.now()), and `'static'` data
 * is never stale (any number, even Infinity, is compared with Date.now()).
 * Reads are off unless a hook turns them on itself (`useJob`, `useCalc`):
 * a hook that polls (`useDocument` while a document is being read) would
 * otherwise ask an API the sample does not have every 1.5 s.
 */
export function seededClient(screen: SampleScreenName = 'link') {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        enabled: false,
        staleTime: 'static',
        gcTime: Infinity,
        retry: false,
        refetchOnMount: false,
      },
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
    queryKeys.document(UNREAD_DOC_ID),
    sampleDocumentDetail(
      { id: UNREAD_DOC_ID, status: 'manual_entry_required', status_reason: 'no_model' },
      manualEntryProposal,
    ),
  );
  seed(
    queryKeys.document(BENEFITS_DOC_ID),
    sampleDocumentDetail(sampleBenefitsDocument, sampleBenefitsProposal),
  );
  seed(
    queryKeys.document(EXTRACTING_DOC_ID),
    sampleDocumentDetail({ id: EXTRACTING_DOC_ID, status: 'extracting' }, null),
  );
  seed(
    queryKeys.document(FAILED_DOC_ID),
    sampleDocumentDetail(
      { id: FAILED_DOC_ID, status: 'failed', status_reason: 'unreadable_file' },
      null,
    ),
  );
  seed(
    queryKeys.document(CONFIRMED_DOC_ID),
    sampleDocumentDetail(
      { id: CONFIRMED_DOC_ID, status: 'confirmed', confirmed_at: SAMPLE_NOW },
      null,
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
  SCREENS[screen].seed?.(seed);
  return client;
}

export function SampleScreen({ screen }: { screen: SampleScreenName }) {
  const [client] = useState(() => seededClient(screen));
  const { nav, render, hrefs, done, calculators, accountMenu = false } = SCREENS[screen];
  const context = `${SAMPLE_USER.employer} · ${SAMPLE_USER.frequency}`;
  return (
    <QueryClientProvider client={client}>
      <Shell
        header={
          accountMenu ? (
            <Header chips={[context]} account={<UserMenu label={SAMPLE_USER.name} />} />
          ) : (
            <Header chips={[context, SAMPLE_USER.name]} />
          )
        }
        nav={<SideNav current={nav} hrefs={hrefs} done={done} calculators={calculators} />}
      >
        {render()}
      </Shell>
    </QueryClientProvider>
  );
}
