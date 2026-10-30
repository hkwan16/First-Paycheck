import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECISION_V1_ID } from '@/test/fixtures/decisions';
import { EMERGENCY_DECISION_ID } from '@/test/fixtures/planning';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { savedDecision } from '@/test/msw/db';
import { savedEmergencyFund } from '@/test/msw/planning-handlers';
import { renderWithProviders, screen, within } from '@/test/render';
import { WhyIndexScreen } from './WhyIndexScreen';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
afterEach(() => vi.useRealTimers());

describe('WhyIndexScreen', () => {
  it('lists each current decision with a link to why', async () => {
    savedDecision();
    renderWithProviders(<WhyIndexScreen />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Why each decision' }),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Saved decisions' });
    const [item] = within(list).getAllByRole('listitem');
    expect(item).toHaveTextContent('401(k) match');
    expect(item).toHaveTextContent('v1 · Saved Oct 17, 2026');
    expect(within(item!).getByRole('link', { name: '401(k) match' })).toHaveAttribute(
      'href',
      `/why/${DECISION_V1_ID}`,
    );
  });

  it('never says every decision has an explanation (spec 011 rule 18)', async () => {
    savedDecision();
    savedEmergencyFund();
    renderWithProviders(<WhyIndexScreen />);
    expect(screen.queryByText(/Each saved decision has a plain-language explanation/)).toBeNull();
    expect(
      screen.getByText(/an emergency fund has no tax rule to explain, so its page shows/),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Saved decisions' });
    const fund = within(list)
      .getAllByRole('listitem')
      .find((item) => item.textContent?.includes('Emergency fund'));
    expect(fund).toHaveTextContent('Calculator result, no written explanation');
    expect(within(fund!).getByRole('link', { name: 'Emergency fund' })).toHaveAttribute(
      'href',
      `/why/${EMERGENCY_DECISION_ID}`,
    );
    const k401 = within(list)
      .getAllByRole('listitem')
      .find((item) => item.textContent?.includes('401(k) match'));
    expect(k401).not.toHaveTextContent('no written explanation');
  });

  it('sends someone with nothing saved to the decisions', async () => {
    renderWithProviders(<WhyIndexScreen />);
    expect(await screen.findByText('No decisions saved yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to decisions' })).toHaveAttribute(
      'href',
      '/setup/decisions/emergency-fund',
    );
  });
});
