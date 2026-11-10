import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECISION_V1_ID,
  DECISION_V2_ID,
  sampleCitations,
  sampleExplanation,
  sampleFallbackExplanation,
} from '@/test/fixtures/decisions';
import { EMERGENCY_DECISION_ID } from '@/test/fixtures/planning';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { db, replacedDecision, savedDecision } from '@/test/msw/db';
import { savedEmergencyFund } from '@/test/msw/planning-handlers';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { WhyScreen } from './WhyScreen';

function explainBodies() {
  const bodies: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (new URL(request.url).pathname === '/explain') bodies.push(await request.clone().json());
  });
  return bodies;
}

/** Spec 008 rule 19b: the one note that says what state the explanation is in. */
const note = () => screen.getByRole('region', { name: 'About this explanation' });

/** Words that describe how the app works rather than the person's money (issues 204, 209). */
const INTERNALS =
  /\b(prompt|explain\/v\d+|v\d+|plain code|retr(?:y|ies)|verifier|calculator|language model|AI|curated|fallback)\b/i;

const CHECKED =
  'We checked every number here against the decision you saved, and each source links to the IRS page it quotes.';

function renderWhy(decisionId = DECISION_V1_ID) {
  return renderWithProviders(<WhyScreen decisionId={decisionId} />, {
    advanceTimers: vi.advanceTimersByTime,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) });
  savedDecision();
});
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

describe('WhyScreen, verified', () => {
  it('names the decision and says once, in plain words, that its numbers were checked', async () => {
    const { container } = renderWhy();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Why contribute 4% to your 401(k)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('401(k) match')).toBeInTheDocument();
    expect(screen.getByText('Saved Oct 17, 2026')).toBeInTheDocument();

    await waitFor(() => expect(note()).toHaveTextContent(`${CHECKED} Written Oct 17, 2026.`));
    // Issue 204: no prompt version, retry count or check tiles.
    expect(container).not.toHaveTextContent(INTERNALS);
    expect(screen.queryByText(/Retries/)).not.toBeInTheDocument();
  });

  it('shows the explanation, its numbers and what would change it', async () => {
    renderWhy();
    const meaning = await screen.findByRole('region', { name: 'What this means' });
    expect(meaning).toHaveTextContent(
      'An employer match is pay you receive only when you contribute',
    );
    expect(within(meaning).getAllByText(/./, { selector: 'p' })).toHaveLength(3);

    const numbers = screen.getByRole('region', { name: 'Your numbers' });
    const rows = within(numbers)
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    // The note says once that every figure matched, so no row carries a mark.
    expect(rows).toEqual([
      ['Salary', '$65,000'],
      ['You put in per year', '$2,600'],
      ["Acme's match per year", '$2,600'],
      ['Your marginal rate', '12%'],
      ['2026 limit on your contributions', '$24,500'],
    ]);

    const whatIfs = screen.getByRole('region', { name: 'What would change this' });
    expect(within(whatIfs).getAllByRole('listitem')).toHaveLength(3);
  });

  it('links each IRS source out, with the passage it quotes behind a disclosure', async () => {
    const { user } = renderWhy();
    const sources = await screen.findByRole('region', { name: 'Sources' });
    const items = within(sources).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const [first] = sampleCitations;
    const link = within(items[0]!).getByRole('link', { name: /Matching contributions/ });
    expect(link).toHaveAttribute('href', first!.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleName(`${first!.title} (opens in a new tab)`);
    expect(items[0]).toHaveTextContent('IRS, Retirement Plans, tax year 2026.');

    const passage = within(items[0]!).getByText(/Many retirement plans, such as SIMPLE IRAs/);
    expect(passage).not.toBeVisible();
    await user.click(within(items[0]!).getByText('What it says'));
    expect(passage).toBeVisible();
  });

  it('says when the saved decision will be checked against a pay stub', async () => {
    renderWhy();
    const next = await screen.findByRole('region', { name: 'What happens next' });
    await waitFor(() => expect(next).toHaveTextContent('Oct 31, 2026'));
    expect(next).toHaveTextContent(
      'Check that your next pay stub shows your new 401(k) contribution',
    );
    expect(next).toHaveTextContent(
      'Your monthly check-in will tell you if your pay stub does not show the change.',
    );
    expect(within(next).getByRole('link', { name: 'Change this decision' })).toHaveAttribute(
      'href',
      '/setup/decisions/401k',
    );
    expect(within(next).getByRole('link', { name: 'See your plan' })).toHaveAttribute(
      'href',
      '/plan',
    );
  });
});

describe('WhyScreen, when no explanation could be written', () => {
  beforeEach(() => {
    db.explanations = new Map([[DECISION_V1_ID, [sampleFallbackExplanation()]]]);
  });

  it('says so and shows the numbers saved instead', async () => {
    const { container } = renderWhy();
    await waitFor(() =>
      expect(note()).toHaveTextContent(
        'We could not write an explanation that matches your numbers, so here are the numbers you saved.',
      ),
    );
    expect(within(note()).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(INTERNALS);

    const saved = screen.getByRole('region', { name: 'Your saved numbers' });
    expect(saved).toHaveTextContent(
      'Based onSalary $65,000 · match 100% of the first 4% · your rate 4%',
    );
    expect(saved).toHaveTextContent('Acme Corp adds per year$2,600');
    expect(saved).toHaveTextContent('Match you miss per year$0');
    expect(screen.queryByRole('region', { name: 'Your numbers' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change this decision' })).toHaveAttribute(
      'href',
      '/setup/decisions/401k',
    );
  });

  it('tries again with force, waits for the run, and shows the checked explanation', async () => {
    db.explainOutcomes = ['verified'];
    const bodies = explainBodies();
    // Hold the run open until the test has seen the waiting state.
    let finish = () => {};
    const running = new Promise<void>((resolve) => (finish = resolve));
    server.use(
      http.post(apiUrl('/explain'), async () => {
        await running;
        return undefined;
      }),
    );
    const { user } = renderWhy();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    await user.click(retry);
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Writing the explanation and checking its numbers.',
    );

    finish();
    expect(await screen.findByText(new RegExp(CHECKED))).toBeInTheDocument();
    expect(bodies).toEqual([{ decision_id: DECISION_V1_ID, force: true }]);
    expect(screen.queryByText(/We could not write an explanation/)).not.toBeInTheDocument();
  });

  it('keeps the numbers saved and says calmly when explanations are off', async () => {
    db.llmConfigured = false;
    const { user } = renderWhy();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Explanations are not available right now/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your saved numbers' })).toBeInTheDocument();
  });
});

describe('WhyScreen, out of date (spec 008 rule 19b)', () => {
  beforeEach(() => {
    // Issue 161: verified, but written from figures that have changed since.
    db.explanations = new Map([[DECISION_V1_ID, [sampleExplanation({ stale: true })]]]);
  });

  it('never calls it checked, says so in a note, and still shows what it said', async () => {
    const { container } = renderWhy();
    await waitFor(() =>
      expect(note()).toHaveTextContent(
        'Written Oct 17, 2026. Some of what it was written from has changed since, so a number here may be out of date.',
      ),
    );
    expect(screen.queryByText(new RegExp(CHECKED))).not.toBeInTheDocument();
    // Issue 204: a note with the way to write it again, not an alarm.
    expect(screen.queryByText('Out of date')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(note()).getByRole('button', { name: 'Write it again' })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(INTERNALS);
    expect(screen.getByRole('region', { name: 'What this means' })).toHaveTextContent(
      'An employer match is pay you receive only when you contribute',
    );
  });

  it('writes it again without force and shows the current one', async () => {
    db.explainOutcomes = ['verified'];
    const bodies = explainBodies();
    const { user } = renderWhy();
    const again = await screen.findByRole('button', { name: 'Write it again' });
    await user.click(again);
    expect(await screen.findByText(new RegExp(CHECKED))).toBeInTheDocument();
    expect(bodies).toEqual([{ decision_id: DECISION_V1_ID, force: false }]);
    expect(screen.queryByText(/may be out of date/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write it again' })).not.toBeInTheDocument();
  });

  it('says the same on one that could not be written', async () => {
    db.explanations = new Map([[DECISION_V1_ID, [sampleFallbackExplanation({ stale: true })]]]);
    renderWhy();
    await waitFor(() =>
      expect(note()).toHaveTextContent('Some of your information has changed since.'),
    );
  });
});

describe('WhyScreen with no explanation yet', () => {
  beforeEach(() => {
    db.explanations = new Map();
  });

  it('offers to write one, and shows it once checked', async () => {
    const bodies = explainBodies();
    const { user } = renderWhy();
    const card = await screen.findByRole('region', { name: 'No explanation yet' });
    expect(card).toHaveTextContent(
      'We write it from the decision you saved and the IRS rules behind it, and check every number before you see it.',
    );
    await user.click(within(card).getByRole('button', { name: 'Write the explanation' }));
    expect(await screen.findByText(new RegExp(CHECKED))).toBeInTheDocument();
    expect(bodies).toEqual([{ decision_id: DECISION_V1_ID, force: false }]);
  });

  it('says calmly that explanations are off, and still shows the numbers saved', async () => {
    db.llmConfigured = false;
    const { user } = renderWhy();
    const card = await screen.findByRole('region', { name: 'No explanation yet' });
    await user.click(within(card).getByRole('button', { name: 'Write the explanation' }));
    const notice = await screen.findByText(/Explanations are not available right now/);
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your saved numbers' })).toHaveTextContent(
      'Contribution for the full match4% of salary',
    );
  });
});

describe('WhyScreen for an emergency fund (spec 011 rule 18, issue 162)', () => {
  beforeEach(() => savedEmergencyFund());

  it('says in its lead why there is none, offers none, and shows the numbers saved', async () => {
    const bodies = explainBodies();
    const { container } = renderWhy(EMERGENCY_DECISION_ID);
    expect(
      await screen.findByText(
        'An emergency fund has no tax rules behind it, so this page shows the numbers you saved.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /explanation/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/emergency_fund/)).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(INTERNALS);

    const result = await screen.findByRole('region', { name: 'Your saved numbers' });
    const rows = within(result)
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ['Target, 3 months of essentials', '$5,469.75'],
      ['Suggested range, 3 to 6 months', '$5,469.75 to $10,939.50'],
      ['Already saved', '39.12% of the target'],
      ['Still to save', '$3,329.75'],
      ['Months to reach it', '12 months'],
      ['Per paycheck, 24 paychecks a year', '$150.00'],
    ]);
    expect(screen.getByRole('link', { name: 'Change this decision' })).toHaveAttribute(
      'href',
      '/setup/decisions/emergency-fund',
    );
    expect(bodies).toEqual([]);
  });
});

describe('WhyScreen, "Your numbers" (spec 008 rule 19d, issue 243)', () => {
  it('shows every label in sentence case, leaving names as they are', async () => {
    db.explanations = new Map([
      [
        DECISION_V1_ID,
        [
          sampleExplanation({
            numbers: [
              { value: '4%', label: 'rate you chose' },
              { value: '0%', label: '401(k) rate on your pay stub now' },
              { value: '$2,600', label: "acme's match per year" },
              { value: '12%', label: 'Your marginal rate' },
            ],
          }),
        ],
      ],
    ]);
    renderWhy();
    const numbers = await screen.findByRole('region', { name: 'Your numbers' });
    expect(
      within(numbers)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual([
      'Rate you chose',
      '401(k) rate on your pay stub now',
      "Acme's match per year",
      'Your marginal rate',
    ]);
  });
});

describe('WhyScreen, a replaced decision (spec 008 rule 19c, issue 227)', () => {
  beforeEach(() => replacedDecision());

  /** The note about the decision, in place of the one about its explanation. */
  const replacedNote = () => screen.getByRole('region', { name: 'About this decision' });

  const REPLACED =
    'You saved a newer version of this decision on Oct 17, 2026. This page keeps the one you saved on Oct 17, 2026 as it was.';

  it('says a newer version replaced it and links to the current one', async () => {
    renderWhy();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Why contribute 4% to your 401(k)' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(replacedNote()).toHaveTextContent(REPLACED));
    expect(screen.getByText('Replaced')).toBeInTheDocument();
    expect(
      within(replacedNote()).getByRole('link', { name: 'See the current decision' }),
    ).toHaveAttribute('href', `/why/${DECISION_V2_ID}`);
    // The checked note would make it look current: the replaced note takes its place.
    expect(screen.queryByText(new RegExp(CHECKED))).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'About this explanation' }),
    ).not.toBeInTheDocument();
    // What it said is kept, with its sources.
    expect(screen.getByRole('region', { name: 'What this means' })).toHaveTextContent(
      'An employer match is pay you receive only when you contribute',
    );
    expect(screen.getByRole('region', { name: 'Sources' })).toBeInTheDocument();
  });

  it('offers nothing that acts on the current decision', async () => {
    renderWhy();
    await waitFor(() => expect(replacedNote()).toHaveTextContent(REPLACED));
    expect(screen.queryByRole('link', { name: 'Change this decision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'What happens next' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'See your plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps a stale explanation without offering to write it again', async () => {
    db.explanations = new Map([[DECISION_V1_ID, [sampleExplanation({ stale: true })]]]);
    renderWhy();
    await waitFor(() => expect(replacedNote()).toHaveTextContent(REPLACED));
    expect(screen.queryByRole('button', { name: 'Write it again' })).not.toBeInTheDocument();
  });

  it('shows the saved numbers of one that could not be written, without Try again', async () => {
    db.explanations = new Map([[DECISION_V1_ID, [sampleFallbackExplanation()]]]);
    renderWhy();
    await waitFor(() => expect(replacedNote()).toHaveTextContent(REPLACED));
    expect(screen.getByRole('region', { name: 'Your saved numbers' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Change this decision' })).not.toBeInTheDocument();
  });

  it('says none was written, and offers to write none', async () => {
    db.explanations = new Map();
    renderWhy();
    await waitFor(() => expect(replacedNote()).toHaveTextContent(REPLACED));
    expect(
      await screen.findByText(
        'No explanation was written for this decision before it was replaced.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write the explanation' })).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Your saved numbers' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Change this decision' })).not.toBeInTheDocument();
  });

  it('says an emergency fund was replaced, above its saved numbers', async () => {
    savedEmergencyFund();
    const fund = db.decisions.find((d) => d.id === EMERGENCY_DECISION_ID)!;
    db.decisions.push({
      ...fund,
      id: 'dec00000-0000-4000-8000-0000000000e2',
      version: 2,
      supersedes_id: EMERGENCY_DECISION_ID,
      created_at: '2026-10-18T15:00:00Z',
    });
    renderWhy(EMERGENCY_DECISION_ID);
    await waitFor(() =>
      expect(replacedNote()).toHaveTextContent(
        'You saved a newer version of this decision on Oct 18, 2026.',
      ),
    );
    expect(
      within(replacedNote()).getByRole('link', { name: 'See the current decision' }),
    ).toHaveAttribute('href', '/why/dec00000-0000-4000-8000-0000000000e2');
    expect(await screen.findByRole('region', { name: 'Your saved numbers' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Change this decision' })).not.toBeInTheDocument();
  });

  it('shows the current one as current', async () => {
    renderWhy(DECISION_V2_ID);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Why contribute 5% to your 401(k)' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Write the explanation' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Replaced')).not.toBeInTheDocument();
    expect(screen.queryByText(/You saved a newer version/)).not.toBeInTheDocument();
  });
});

describe('WhyScreen for a decision that is not there', () => {
  it('says so and links to the saved decisions', async () => {
    renderWhy('dec00000-0000-4000-8000-00000000ffff');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Decision not found' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See your saved decisions' })).toHaveAttribute(
      'href',
      '/why',
    );
  });
});
