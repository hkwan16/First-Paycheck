import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALCULATORS } from '@/lib/features';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { decisionsReady, savedDecision } from '@/test/msw/db';
import {
  benefitsConfirmed,
  savedEmergencyFund,
  savedHealthPlan,
  savedW4,
} from '@/test/msw/planning-handlers';
import { server } from '@/test/msw/server';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { DecisionStepScreen } from './DecisionStepScreen';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

const CARD_NAMES = ['Emergency fund', '401(k) match', 'Health plan', 'W-4, federal only'];

/** Every decision card region on the page, by name. */
const cardsOnPage = () =>
  screen
    .queryAllByRole('region')
    .map((region) => region.getAttribute('aria-labelledby'))
    .filter((id) => id !== null)
    .map((id) => document.getElementById(id)?.textContent)
    .filter((name) => name !== undefined && CARD_NAMES.includes(name));

describe('DecisionStepScreen (spec 018)', () => {
  it('names the decision, its place in the order and how many are saved, with one card', async () => {
    savedDecision();
    renderWithProviders(<DecisionStepScreen calculator="401k_match" calculators={CALCULATORS} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'How much to put in your 401(k)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Decision 2 of 4')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/of 4 saved/)).toHaveTextContent('1 of 4 saved'));
    expect(await screen.findByRole('region', { name: '401(k) match' })).toBeInTheDocument();
    expect(cardsOnPage()).toEqual(['401(k) match']);
  });

  it.each([
    ['emergency_fund', 'Emergency fund', 'How much to keep for emergencies', 'Decision 1 of 4'],
    ['health_plan', 'Health plan', 'Which health plan to choose', 'Decision 3 of 4'],
    ['w4', 'W-4, federal only', 'What to put on your W-4', 'Decision 4 of 4'],
  ] as const)('renders only the %s card', async (calculator, card, title, eyebrow) => {
    decisionsReady();
    benefitsConfirmed();
    renderWithProviders(<DecisionStepScreen calculator={calculator} calculators={CALCULATORS} />);
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByText(eyebrow)).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: card })).toBeInTheDocument();
    expect(cardsOnPage()).toEqual([card]);
  });

  it('shows each live card working: the controls a person moves', async () => {
    decisionsReady();
    benefitsConfirmed();
    const { unmount } = renderWithProviders(
      <DecisionStepScreen calculator="emergency_fund" calculators={CALCULATORS} />,
    );
    expect(await screen.findByRole('slider', { name: /Months of essentials/ })).toBeInTheDocument();
    unmount();
    renderWithProviders(<DecisionStepScreen calculator="w4" calculators={CALCULATORS} />);
    expect(await screen.findByRole('group', { name: 'Filing status' })).toBeInTheDocument();
    expect(screen.queryByText('After alpha')).toBeNull();
  });

  it('keeps one card at a comfortable width', () => {
    renderWithProviders(<DecisionStepScreen calculator="w4" calculators={['401k_match']} />);
    expect(screen.getByRole('heading', { level: 1 }).closest('.max-w-3xl')).not.toBeNull();
    const card = screen.getByRole('region', { name: 'W-4, federal only' });
    expect(card.closest('.max-w-3xl')).not.toBeNull();
  });

  it('counts nothing saved for a new user', async () => {
    decisionsReady();
    renderWithProviders(
      <DecisionStepScreen calculator="401k_match" calculators={['401k_match']} />,
    );
    expect(await screen.findByText(/of 4 saved/)).toHaveTextContent('0 of 4 saved');
  });

  it('counts a saved W-4 with the rest: four of four', async () => {
    savedDecision();
    savedEmergencyFund();
    savedHealthPlan();
    savedW4();
    renderWithProviders(<DecisionStepScreen calculator="w4" calculators={CALCULATORS} />);
    await waitFor(() => expect(screen.getByText(/of 4 saved/)).toHaveTextContent('4 of 4 saved'));
    expect(
      await within(screen.getByRole('region', { name: 'W-4, federal only' })).findByText(
        'Saved v1 · Oct 17',
      ),
    ).toBeInTheDocument();
  });

  it('shows a calculator off in this build as the After alpha placeholder (the alpha flag)', async () => {
    savedDecision();
    renderWithProviders(<DecisionStepScreen calculator="w4" calculators={['401k_match']} />);
    const w4 = screen.getByRole('region', { name: 'W-4, federal only' });
    expect(within(w4).getByText('After alpha')).toBeInTheDocument();
    expect(within(w4).queryByRole('group', { name: 'Filing status' })).toBeNull();
    expect(
      screen.getByRole('heading', { level: 1, name: 'What to put on your W-4' }),
    ).toBeVisible();
    await waitFor(() => expect(screen.getByText(/of 4 saved/)).toHaveTextContent('1 of 4 saved'));
  });

  it('leads with how to use the calculator only when there is one', () => {
    const lead = /Move the controls to try what-ifs/;
    const { unmount } = renderWithProviders(
      <DecisionStepScreen calculator="401k_match" calculators={['401k_match']} />,
    );
    expect(screen.getByText(lead)).toBeInTheDocument();
    unmount();
    renderWithProviders(<DecisionStepScreen calculator="w4" calculators={['401k_match']} />);
    expect(screen.queryByText(lead)).toBeNull();
  });

  it('shows the 401(k) as a placeholder too when it is off', () => {
    renderWithProviders(<DecisionStepScreen calculator="401k_match" calculators={[]} />);
    expect(
      within(screen.getByRole('region', { name: '401(k) match' })).getByText('After alpha'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('goes back to Spending from the first step and on to the next', () => {
    renderWithProviders(
      <DecisionStepScreen calculator="emergency_fund" calculators={CALCULATORS} />,
    );
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/setup/spending');
    expect(screen.getByRole('link', { name: 'Next: 401(k) match' })).toHaveAttribute(
      'href',
      '/setup/decisions/401k',
    );
  });

  it('goes back a step from the W-4 and on to the plan', () => {
    renderWithProviders(<DecisionStepScreen calculator="w4" calculators={CALCULATORS} />);
    expect(screen.getByRole('link', { name: 'Back to health plan' })).toHaveAttribute(
      'href',
      '/setup/decisions/health-plan',
    );
    expect(screen.getByRole('link', { name: 'See your plan' })).toHaveAttribute('href', '/plan');
  });

  it('walks only the live steps in the alpha: Spending, the 401(k), the plan', () => {
    renderWithProviders(
      <DecisionStepScreen calculator="401k_match" calculators={['401k_match']} />,
    );
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/setup/spending');
    expect(screen.getByRole('link', { name: 'See your plan' })).toHaveAttribute('href', '/plan');
  });
});
