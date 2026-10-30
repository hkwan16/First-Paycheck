import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECISION_V1_ID,
  sampleCitations,
  sampleExplanation,
  sampleFallbackExplanation,
} from '@/test/fixtures/decisions';
import { EMERGENCY_DECISION_ID } from '@/test/fixtures/planning';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { db, savedDecision } from '@/test/msw/db';
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

const status = () => screen.getByRole('region', { name: 'Verification status' });

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
  it('names the decision and shows the verification checks', async () => {
    renderWhy();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Why contribute 4% to your 401(k)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('401(k) match · decision v1')).toBeInTheDocument();
    expect(screen.getByText('Saved Oct 17, 2026')).toBeInTheDocument();

    await screen.findByText('Verified against calculator');
    expect(status()).toHaveTextContent('Numbers checked12 of 12 match the calculator');
    expect(status()).toHaveTextContent('Citations3 of 3 resolve to a source');
    expect(status()).toHaveTextContent('Retries0');
    expect(status()).toHaveTextContent('explain/v1');
  });

  it('shows the explanation, its numbers each marked as checked, and what would change it', async () => {
    renderWhy();
    const concept = await screen.findByRole('region', { name: 'The concept' });
    expect(concept).toHaveTextContent(
      'An employer match is pay you receive only when you contribute',
    );
    expect(within(concept).getAllByText(/./, { selector: 'p' })).toHaveLength(3);

    const numbers = screen.getByRole('region', { name: 'Your numbers' });
    const rows = within(numbers)
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ['Salary', '$65,000='],
      ['You put in per year', '$2,600='],
      ["Acme's match per year", '$2,600='],
      ['Your marginal rate', '12%='],
      ['2026 limit on your contributions', '$24,500='],
    ]);
    expect(within(numbers).getAllByLabelText('matches calculator')).toHaveLength(5);
    expect(numbers).toHaveTextContent("calculator's output for decision v1");

    const whatIfs = screen.getByRole('region', { name: 'What would change the answer' });
    expect(within(whatIfs).getAllByRole('listitem')).toHaveLength(3);
  });

  it('links each IRS citation out, with the passage it quotes', async () => {
    renderWhy();
    const sources = await screen.findByRole('region', { name: 'Sources' });
    const items = within(sources).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const [first] = sampleCitations;
    const link = within(items[0]!).getByRole('link', { name: /Matching contributions/ });
    expect(link).toHaveAttribute('href', first!.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleName(`${first!.title} (opens in a new tab)`);
    expect(items[0]).toHaveTextContent('Many retirement plans, such as SIMPLE IRAs and 401(k)s');
    expect(items[0]).toHaveTextContent('IRS, Retirement Plans. Curated citation, tax year 2026.');
  });

  it('says when the saved decision will be checked against a pay stub', async () => {
    renderWhy();
    const next = await screen.findByRole('region', { name: 'What happens next' });
    await waitFor(() => expect(next).toHaveTextContent('Oct 31, 2026'));
    expect(next).toHaveTextContent(
      'Check that your next pay stub shows your new 401(k) contribution',
    );
    expect(within(next).getByRole('link', { name: 'Re-run the calculator' })).toHaveAttribute(
      'href',
      '/setup/decisions/401k',
    );
    expect(within(next).getByRole('link', { name: 'See the plan' })).toHaveAttribute(
      'href',
      '/plan',
    );
  });
});

describe('WhyScreen, fallback', () => {
  beforeEach(() => {
    db.explanations = new Map([[DECISION_V1_ID, [sampleFallbackExplanation()]]]);
  });

  it("shows the calculator's own result and says the explanation could not be verified", async () => {
    renderWhy();
    await screen.findByText('Could not verify the explanation');
    expect(status()).toHaveTextContent('Shown insteadPlain calculator result');
    expect(status()).toHaveTextContent('Retries1');
    expect(status()).toHaveTextContent('after one retry');

    const fallback = screen.getByRole('region', { name: '401(k) match calculator result' });
    expect(within(fallback).getByText('Fallback')).toBeInTheDocument();
    expect(fallback).toHaveTextContent(
      'InputsSalary $65,000 · match 100% of the first 4% · contribution 4%',
    );
    expect(fallback).toHaveTextContent('Acme Corp adds per year$2,600');
    expect(fallback).toHaveTextContent('Match you miss per year$0');
    expect(screen.queryByRole('region', { name: 'Your numbers' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('matches calculator')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Re-run the calculator' })).toHaveAttribute(
      'href',
      '/setup/decisions/401k',
    );
  });

  it('tries again with force, waits for the run, and shows the verified explanation', async () => {
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
    const retry = await screen.findByRole('button', { name: 'Try writing the explanation again' });
    await user.click(retry);
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Writing the explanation and checking its numbers.',
    );

    finish();
    expect(await screen.findByText('Verified against calculator')).toBeInTheDocument();
    expect(bodies).toEqual([{ decision_id: DECISION_V1_ID, force: true }]);
    expect(screen.queryByText('Could not verify the explanation')).not.toBeInTheDocument();
  });

  it('keeps the fallback and explains calmly when no model is configured', async () => {
    db.llmConfigured = false;
    const { user } = renderWhy();
    await user.click(
      await screen.findByRole('button', { name: 'Try writing the explanation again' }),
    );
    expect(await screen.findByText(/Explanations are not available yet/)).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: '401(k) match calculator result' }),
    ).toBeInTheDocument();
  });
});

describe('WhyScreen, out of date (spec 008 rule 19b)', () => {
  beforeEach(() => {
    // Issue 161: verified, but written from figures that have changed since.
    db.explanations = new Map([[DECISION_V1_ID, [sampleExplanation({ stale: true })]]]);
  });

  it('never calls it verified, says why, and still shows what it said', async () => {
    renderWhy();
    expect(await screen.findByText('Out of date')).toBeInTheDocument();
    expect(screen.queryByText('Verified against calculator')).not.toBeInTheDocument();
    expect(status()).toHaveTextContent(
      'It was checked against figures that have changed since, so it may no longer be right.',
    );
    expect(screen.getByRole('region', { name: 'The concept' })).toHaveTextContent(
      'An employer match is pay you receive only when you contribute',
    );
  });

  it('writes it again without force and shows the current one', async () => {
    db.explainOutcomes = ['verified'];
    const bodies = explainBodies();
    const { user } = renderWhy();
    const again = await screen.findByRole('button', { name: 'Write it again' });
    await user.click(again);
    expect(await screen.findByText('Verified against calculator')).toBeInTheDocument();
    expect(bodies).toEqual([{ decision_id: DECISION_V1_ID, force: false }]);
    expect(screen.queryByText('Out of date')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write it again' })).not.toBeInTheDocument();
  });

  it('says the same on a stale fallback', async () => {
    db.explanations = new Map([[DECISION_V1_ID, [sampleFallbackExplanation({ stale: true })]]]);
    renderWhy();
    await screen.findByText('Could not verify the explanation');
    expect(status()).toHaveTextContent('It was also written from figures that have changed since.');
  });
});

describe('WhyScreen with no explanation yet', () => {
  beforeEach(() => {
    db.explanations = new Map();
  });

  it('offers to write one, and shows it once verified', async () => {
    const bodies = explainBodies();
    const { user } = renderWhy();
    const card = await screen.findByRole('region', { name: 'No explanation yet' });
    await user.click(within(card).getByRole('button', { name: 'Write the explanation' }));
    expect(await screen.findByText('Verified against calculator')).toBeInTheDocument();
    expect(bodies).toEqual([{ decision_id: DECISION_V1_ID, force: false }]);
  });

  it('says calmly that explanations are not set up, and still shows the calculator result', async () => {
    db.llmConfigured = false;
    const { user } = renderWhy();
    const card = await screen.findByRole('region', { name: 'No explanation yet' });
    await user.click(within(card).getByRole('button', { name: 'Write the explanation' }));
    const notice = await screen.findByText(/Explanations are not available yet/);
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: '401(k) match calculator result' }),
    ).toHaveTextContent('Contribution for the full match4% of salary');
  });
});

describe('WhyScreen for an emergency fund (spec 011 rule 18, issue 162)', () => {
  beforeEach(() => savedEmergencyFund());

  it('says it has no written explanation, offers none, and shows the calculator result', async () => {
    const bodies = explainBodies();
    renderWhy(EMERGENCY_DECISION_ID);
    const none = await screen.findByRole('region', { name: 'No written explanation' });
    expect(none).toHaveTextContent('no tax rule applies, so there is nothing to explain or cite');
    expect(screen.queryByRole('button', { name: /explanation/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/emergency_fund/)).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing on this page came from a language model/)).toBeInTheDocument();

    const result = screen.getByRole('region', { name: 'Emergency fund calculator result' });
    // A saved result, not a written explanation that failed.
    expect(within(result).queryByText('Fallback')).not.toBeInTheDocument();
    const rows = within(result)
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ['Target, 3 months of essentials', '$5,469.75'],
      ['Suggested range, 3 to 6 months', '$5,469.75 to $10,939.50'],
      ['Already saved', '39.12% of the target'],
      ['Still to save', '$3,329.75'],
      ['Months to reach it', '12 months'],
      ['Per paycheck, 24 a year', '$150.00'],
    ]);
    expect(screen.getByRole('link', { name: 'Change it on its step' })).toHaveAttribute(
      'href',
      '/setup/decisions/emergency-fund',
    );
    expect(bodies).toEqual([]);
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
