import { http, HttpResponse } from 'msw';
import type { PlaidLinkOptionsWithLinkToken } from 'react-plaid-link';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALC_DEBOUNCE_MS } from '@/lib/api/hooks';
import { installFakeXhr } from '@/test/fake-xhr';
import { DECISION_V1_ID } from '@/test/fixtures/decisions';
import { NOVEMBER_ID } from '@/test/fixtures/checkins';
import { sampleDocument } from '@/test/fixtures/documents';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { db, decisionsReady, savedDecision } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { savedEmergencyFund } from '@/test/msw/planning-handlers';
import { server } from '@/test/msw/server';
import {
  act,
  fireEvent,
  renderWithProviders,
  screen,
  waitFor,
  within,
  type userEvent,
} from '@/test/render';
import { CheckInScreen } from './check-in/CheckInScreen';
import { EmergencyFundCard } from './decisions/EmergencyFundCard';
import { Match401kCard } from './decisions/Match401kCard';
import { CsvImport } from './link/CsvImport';
import { LinkScreen } from './link/LinkScreen';
import { PlanScreen } from './plan/PlanScreen';
import { RecurringCard } from './spending/RecurringCard';
import { SpendingScreen } from './spending/SpendingScreen';
import { WhyScreen } from './why/WhyScreen';

/*
 * Every mutation surface, refused with a 429 (Retry-After: 1200) and with a
 * 413 body_too_large, shows the shared sentence (`apiErrorMessage`, through
 * `rateLimitMessage`) or the API's own message, after its own lead.
 */

// Plaid Link is a third-party iframe; these tests only ask for a link token.
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (config: PlaidLinkOptionsWithLinkToken) => ({
    open: vi.fn(),
    ready: config.token !== null,
    error: null,
    exit: vi.fn(),
  }),
}));
vi.mock('@/lib/plaid-script', () => ({
  loadPlaidScript: () => Promise.resolve(),
  usePlaidScript: () => 'ready',
}));

const WAIT = 'You have reached the limit for now. Try again in about 20 minutes.';
const TOO_LARGE = 'The request body is larger than 1 MB';

type User = ReturnType<typeof userEvent.setup>;
type Method = 'post' | 'patch' | 'put' | 'delete';
type Xhr = ReturnType<typeof installFakeXhr>;

interface Surface {
  name: string;
  /** The route refused, or `xhr` for the uploads (which MSW does not see in jsdom). */
  route: [Method, string] | 'xhr';
  arrange?: () => void;
  ui: () => ReactElement;
  act: (user: User, xhr: Xhr) => Promise<void>;
  /** The surface's own words before the shared sentence. */
  lead?: string;
}

const RATE_LIMITED = {
  error: { code: 'rate_limited', message: 'Too many requests; try again in 1200 seconds' },
};
const BODY_TOO_LARGE = { error: { code: 'body_too_large', message: TOO_LARGE } };

function refuse(route: [Method, string], status: 429 | 413) {
  const [method, path] = route;
  server.use(
    http[method](apiUrl(path), () =>
      status === 429
        ? HttpResponse.json(RATE_LIMITED, { status, headers: { 'Retry-After': '1200' } })
        : HttpResponse.json(BODY_TOO_LARGE, { status }),
    ),
  );
}

/** The uploads answer through the fake XHR once the request is out. */
async function refuseUpload(xhr: Xhr) {
  await waitFor(() => expect(xhr.requests).toHaveLength(1));
  act(() => xhr.last().respond(429, RATE_LIMITED, { 'Retry-After': '1200' }));
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));
const region = (name: string | RegExp) => screen.getByRole('region', { name });

async function saveFirst401k(user: User) {
  const card = await screen.findByRole('region', { name: '401(k) match' });
  const slider = await within(card).findByRole('slider', { name: /Your contribution/ });
  fireEvent.change(slider, { target: { value: '4' } });
  await settle();
  const save = within(card).getByRole('button', { name: /^Save/ });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
}

async function chaseLoaded() {
  await screen.findByRole('group', { name: 'Chase Total Checking' });
}

const SURFACES: readonly Surface[] = [
  {
    name: 'saving a decision',
    route: ['post', '/decisions'],
    arrange: decisionsReady,
    ui: () => <Match401kCard />,
    act: saveFirst401k,
  },
  {
    name: 'writing an explanation',
    route: ['post', '/explain'],
    arrange: () => {
      savedDecision();
      db.explanations = new Map();
    },
    ui: () => <WhyScreen decisionId={DECISION_V1_ID} />,
    act: async (user) => {
      const card = await screen.findByRole('region', { name: 'No explanation yet' });
      await user.click(within(card).getByRole('button', { name: 'Write the explanation' }));
    },
  },
  {
    name: 'uploading a document',
    route: 'xhr',
    ui: () => <LinkScreen />,
    act: async (user, xhr) => {
      const docs = await screen.findByRole('region', { name: 'Documents' });
      await user.upload(
        await within(docs).findByLabelText(/Add another document/),
        new File(['%PDF-1.7 synthetic'], 'acme.pdf', { type: 'application/pdf' }),
      );
      await refuseUpload(xhr);
    },
    lead: 'acme.pdf was not uploaded.',
  },
  {
    name: 'reading a document',
    route: ['post', '/docs/:id/extract'],
    arrange: () => {
      db.documents = [sampleDocument({ status: 'uploaded', page_count: null, redaction_count: 0 })];
    },
    ui: () => <LinkScreen />,
    act: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Read pay stub' }));
    },
    lead: 'Could not start reading the pay stub.',
  },
  {
    name: 'importing a CSV',
    route: 'xhr',
    ui: () => <CsvImport />,
    act: async (user, xhr) => {
      const panel = region('Import a CSV');
      await user.upload(
        within(panel).getByLabelText(/Choose a CSV file/),
        new File(['Date,Description,Amount\n'], 'export.csv', { type: 'text/csv' }),
      );
      await user.click(within(panel).getByRole('button', { name: 'Import CSV' }));
      await refuseUpload(xhr);
    },
    lead: 'Could not import export.csv.',
  },
  {
    name: 'exporting the plan',
    route: ['post', '/plan/export'],
    ui: () => <PlanScreen />,
    act: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Download PDF' }));
    },
  },
  {
    name: 'starting Plaid Link',
    route: ['post', '/sync/link-token'],
    ui: () => <LinkScreen />,
    act: async (user) => {
      await chaseLoaded();
      await user.click(screen.getByRole('button', { name: 'Link another bank with Plaid' }));
    },
    lead: 'Could not start Plaid Link.',
  },
  {
    name: 'linking the sandbox bank',
    route: ['post', '/sync/items'],
    ui: () => <LinkScreen showSandboxLink />,
    act: async (user) => {
      await chaseLoaded();
      await user.click(screen.getByRole('button', { name: 'Link sandbox bank (test)' }));
    },
    lead: 'Could not link the sandbox bank.',
  },
  {
    name: 'syncing now',
    route: ['post', '/sync/items/:id/sync'],
    ui: () => <LinkScreen />,
    act: async (user) => {
      await chaseLoaded();
      await user.click(screen.getByRole('button', { name: 'Sync now for Chase' }));
    },
    lead: 'Could not sync Chase.',
  },
  {
    name: 'unlinking an institution',
    route: ['delete', '/sync/items/:id'],
    ui: () => <LinkScreen />,
    act: async (user) => {
      await chaseLoaded();
      await user.click(screen.getByRole('button', { name: 'Unlink Chase' }));
      await user.click(screen.getByRole('button', { name: 'Yes, unlink Chase' }));
    },
    lead: 'Could not unlink Chase.',
  },
  {
    name: 'changing an account role',
    route: ['patch', '/accounts/:id'],
    ui: () => <LinkScreen />,
    act: async (user) => {
      await chaseLoaded();
      const checking = screen.getByRole('group', { name: 'Chase Total Checking' });
      await user.selectOptions(within(checking).getByRole('combobox', { name: 'Role' }), [
        'Retirement',
      ]);
    },
    lead: 'Could not save the role.',
  },
  {
    name: 'fixing a category',
    route: ['patch', '/transactions/:id'],
    ui: () => <SpendingScreen />,
    act: async (user) => {
      const [row] = await screen.findAllByRole('row', { name: /Sweetgreen/ });
      await user.selectOptions(
        within(row!).getByRole('combobox', { name: 'Category for Sweetgreen' }),
        ['Groceries'],
      );
    },
  },
  {
    name: 'marking a recurring charge',
    route: ['patch', '/recurring/:id'],
    ui: () => <RecurringCard />,
    act: async (user) => {
      const [row] = await screen.findAllByRole('listitem', { name: /Spotify/ });
      await user.click(within(row!).getByRole('button', { name: 'Not recurring' }));
    },
    lead: 'Could not save Spotify.',
  },
  {
    name: 'acting on a check-in finding',
    route: ['patch', '/check-ins/:id/findings/:fid'],
    ui: () => <CheckInScreen checkInId={NOVEMBER_ID} />,
    act: async (user) => {
      const row = await screen.findByRole('listitem', {
        name: 'Your 401(k) contribution is 2%, not the 4% you chose.',
      });
      await user.click(within(row).getByRole('button', { name: 'Done' }));
    },
    lead: 'It is back to how it was.',
  },
  {
    name: 'pausing a goal',
    route: ['patch', '/goals/:id'],
    arrange: () => {
      decisionsReady();
      savedEmergencyFund();
    },
    ui: () => <EmergencyFundCard />,
    act: async (user) => {
      const goal = await screen.findByRole('group', { name: 'Your emergency fund goal' });
      await user.click(within(goal).getByRole('button', { name: 'Pause' }));
    },
  },
];

let xhr: Xhr;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) });
  xhr = installFakeXhr();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function run(surface: Surface) {
  surface.arrange?.();
  return renderWithProviders(surface.ui(), { advanceTimers: vi.advanceTimersByTime });
}

/** The live region that says it, with the surface's lead when it has one. */
async function expectSaid(sentence: string, lead?: string) {
  const found = await screen.findByText((_, element) =>
    Boolean(
      element?.matches('[role="alert"], [role="status"]') &&
      element.textContent?.includes(sentence),
    ),
  );
  if (lead) expect(found).toHaveTextContent(lead);
  return found;
}

describe('a 429 on every mutation surface', () => {
  it.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    '%s says when to try again',
    async (_, surface) => {
      if (surface.route !== 'xhr') refuse(surface.route, 429);
      const { user } = run(surface);
      await surface.act(user, xhr);
      await expectSaid(WAIT, surface.lead);
    },
  );
});

describe('a 413 body_too_large on the JSON surfaces', () => {
  const json = SURFACES.filter((surface) => surface.route !== 'xhr');
  it.each(json.map((surface) => [surface.name, surface] as const))(
    '%s gives the API message',
    async (_, surface) => {
      refuse(surface.route as [Method, string], 413);
      const { user } = run(surface);
      await surface.act(user, xhr);
      await expectSaid(TOO_LARGE, surface.lead);
    },
  );
});
