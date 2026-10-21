import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { decisionsReady, savedDecision } from '@/test/msw/db';
import { benefitsConfirmed, savedEmergencyFund } from '@/test/msw/planning-handlers';
import { server } from '@/test/msw/server';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { DecisionsScreen } from './DecisionsScreen';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

const PLACEHOLDERS = ['Emergency fund', 'Health plan', 'W-4, federal only'];

describe('DecisionsScreen', () => {
  it('shows the four cards in the mockup order with how many are saved', async () => {
    savedDecision();
    renderWithProviders(<DecisionsScreen calculators={['401k_match']} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Four decisions for your first month' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/of 4 saved/)).toHaveTextContent('1 of 4 saved'));
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual(['Emergency fund', '401(k) match', 'Health plan', 'W-4, federal only']);
  });

  it('counts nothing saved for a new user', async () => {
    decisionsReady();
    renderWithProviders(<DecisionsScreen calculators={['401k_match']} />);
    expect(await screen.findByText(/of 4 saved/)).toHaveTextContent('0 of 4 saved');
  });

  it('renders the calculators off in this build as After alpha placeholders (the alpha flag)', async () => {
    decisionsReady();
    renderWithProviders(<DecisionsScreen calculators={['401k_match']} />);
    for (const name of PLACEHOLDERS) {
      expect(
        within(screen.getByRole('region', { name })).getByText('After alpha'),
      ).toBeInTheDocument();
    }
    expect(await screen.findByRole('region', { name: '401(k) match' })).toBeInTheDocument();
  });

  it('renders the emergency fund and health plan cards when live, and the W-4 as coming later', async () => {
    decisionsReady();
    benefitsConfirmed();
    renderWithProviders(
      <DecisionsScreen calculators={['401k_match', 'emergency_fund', 'health_plan', 'w4']} />,
    );
    expect(
      await within(screen.getByRole('region', { name: 'Emergency fund' })).findByRole('slider', {
        name: /Months of essentials/,
      }),
    ).toBeInTheDocument();
    expect(
      await within(screen.getByRole('region', { name: 'Health plan' })).findByRole('group', {
        name: 'Expected healthcare use',
      }),
    ).toBeInTheDocument();
    const w4 = screen.getByRole('region', { name: 'W-4, federal only' });
    expect(within(w4).getByText('Coming later')).toBeInTheDocument();
    expect(w4).toHaveTextContent('Coming in a later milestone.');
    expect(screen.queryByText('After alpha')).toBeNull();
  });

  it('counts every saved calculator in the badge', async () => {
    savedDecision();
    savedEmergencyFund();
    renderWithProviders(
      <DecisionsScreen calculators={['401k_match', 'emergency_fund', 'health_plan', 'w4']} />,
    );
    await waitFor(() => expect(screen.getByText(/of 4 saved/)).toHaveTextContent('2 of 4 saved'));
  });

  it('shows the 401(k) card as a placeholder too when it is off', () => {
    renderWithProviders(<DecisionsScreen calculators={[]} />);
    expect(
      within(screen.getByRole('region', { name: '401(k) match' })).getByText('After alpha'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('goes back to Spending and on to the plan', () => {
    renderWithProviders(<DecisionsScreen calculators={['401k_match']} />);
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/setup/spending');
    expect(screen.getByRole('link', { name: 'See your plan' })).toHaveAttribute('href', '/plan');
  });
});
