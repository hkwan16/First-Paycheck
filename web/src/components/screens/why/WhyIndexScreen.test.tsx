import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECISION_V1_ID,
  DECISION_V2_ID,
  sampleExplanation,
  sampleFallbackExplanation,
} from '@/test/fixtures/decisions';
import { EMERGENCY_DECISION_ID } from '@/test/fixtures/planning';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { db, replacedDecision, savedDecision } from '@/test/msw/db';
import { savedEmergencyFund } from '@/test/msw/planning-handlers';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
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
    expect(item).toHaveTextContent('Saved Oct 17, 2026');
    expect(item).not.toHaveTextContent(/\bv1\b/);
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
      screen.getByText(
        'What each saved decision means for your money. An emergency fund has no tax rules to explain, so its page shows the numbers you saved.',
      ),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Saved decisions' });
    const fund = within(list)
      .getAllByRole('listitem')
      .find((item) => item.textContent?.includes('Emergency fund'));
    expect(fund).toHaveTextContent('Saved Oct 17, 2026 · No written explanation');
    expect(within(fund!).getByRole('link', { name: 'Emergency fund' })).toHaveAttribute(
      'href',
      `/why/${EMERGENCY_DECISION_ID}`,
    );
    const k401 = within(list)
      .getAllByRole('listitem')
      .find((item) => item.textContent?.includes('401(k) match'));
    expect(k401).not.toHaveTextContent('no written explanation');
  });

  describe("each explanation's state (spec 008 rule 19c, issue 227)", () => {
    async function k401Row() {
      const list = await screen.findByRole('list', { name: 'Saved decisions' });
      return within(list)
        .getAllByRole('listitem')
        .find((item) => item.textContent?.includes('401(k) match'))!;
    }

    it.each([
      ['up to date', () => sampleExplanation(), 'Explanation up to date'],
      ['out of date', () => sampleExplanation({ stale: true }), 'Explanation out of date'],
      [
        'could not be written',
        () => sampleFallbackExplanation(),
        'Explanation could not be written',
      ],
    ])('says one is %s', async (_, explanation, text) => {
      savedDecision();
      db.explanations = new Map([[DECISION_V1_ID, [explanation()]]]);
      renderWithProviders(<WhyIndexScreen />);
      const row = await k401Row();
      await waitFor(() => expect(row).toHaveTextContent(text));
      expect(row).toHaveTextContent(`Saved Oct 17, 2026${text}`);
    });

    it('says one is not written yet', async () => {
      savedDecision();
      db.explanations = new Map();
      renderWithProviders(<WhyIndexScreen />);
      const row = await k401Row();
      await waitFor(() => expect(row).toHaveTextContent('Explanation not written yet'));
    });

    it("reads the current version's explanation, not a replaced one's", async () => {
      replacedDecision();
      renderWithProviders(<WhyIndexScreen />);
      const row = await k401Row();
      await waitFor(() => expect(row).toHaveTextContent('Explanation not written yet'));
      expect(within(row).getByRole('link', { name: '401(k) match' })).toHaveAttribute(
        'href',
        `/why/${DECISION_V2_ID}`,
      );
    });

    it('reads nothing for an emergency fund, which is never explained', async () => {
      savedEmergencyFund();
      renderWithProviders(<WhyIndexScreen />);
      const list = await screen.findByRole('list', { name: 'Saved decisions' });
      const fund = within(list).getByRole('listitem');
      expect(fund).toHaveTextContent('No written explanation');
      expect(fund).not.toHaveTextContent(/Explanation (up to date|out of date|not written)/);
    });
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
