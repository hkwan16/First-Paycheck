import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOVEMBER_ID } from '@/test/fixtures/checkins';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { decisionsReady } from '@/test/msw/db';
import { renderWithProviders, screen, userEvent, within } from '@/test/render';
import { CheckInScreen } from './check-in/CheckInScreen';
import { DecisionsScreen } from './decisions/DecisionsScreen';
import { PlanScreen } from './plan/PlanScreen';
import { SpendingScreen } from './spending/SpendingScreen';

/*
 * One card per screen throws while rendering (a field the card expected is
 * missing). Its boundary shows that card's frame and a notice; every other
 * card on the screen keeps rendering and answering.
 */

const { crash } = vi.hoisted(() => ({
  crash: (card: string) => () => {
    throw new TypeError(`Cannot read properties of undefined (reading '${card}')`);
  },
}));
vi.mock('./decisions/W4Card', () => ({ W4Card: crash('w4') }));
vi.mock('./spending/RecurringCard', () => ({ RecurringCard: crash('recurring') }));
vi.mock('./check-in/FindingsCard', () => ({ FindingsCard: crash('findings') }));
vi.mock('./plan/ExportCard', () => ({ ExportCard: crash('export') }));

const NOTICE =
  'This card could not be shown. The rest of the page still works, and nothing you saved has changed.';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) });
  // React logs the caught errors too; the boundary's own line is tested in CardErrorBoundary.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const render = (ui: React.ReactElement) =>
  renderWithProviders(ui, { advanceTimers: vi.advanceTimersByTime });

function expectFallback(name: string) {
  const card = screen.getByRole('region', { name });
  expect(within(card).getByRole('status')).toHaveTextContent(NOTICE);
  expect(within(card).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
}

describe('a card that fails to render', () => {
  it('leaves the other decision cards working', async () => {
    decisionsReady();
    const { user } = render(
      <DecisionsScreen calculators={['401k_match', 'emergency_fund', 'health_plan', 'w4']} />,
    );
    expectFallback('W-4, federal only');
    const k401 = screen.getByRole('region', { name: '401(k) match' });
    const slider = await within(k401).findByRole('slider', { name: /contribution/i });
    slider.focus();
    await user.keyboard('{ArrowRight}');
    expect(slider).toHaveFocus();
    expect(
      within(screen.getByRole('region', { name: 'Emergency fund' })).getByRole('slider', {
        name: /Months of essentials/,
      }),
    ).toBeInTheDocument();
  });

  it('leaves the Sankey and the transactions on Spending', async () => {
    render(<SpendingScreen showSankey />);
    expectFallback('Recurring charges');
    expect(
      await screen.findByRole('region', { name: /Where each dollar of .* pay went/ }),
    ).toBeInTheDocument();
    expect(await screen.findAllByRole('row', { name: /Sweetgreen/ })).not.toHaveLength(0);
  });

  it('leaves net worth and the plan lines on the check-in', async () => {
    render(<CheckInScreen checkInId={NOVEMBER_ID} />);
    await screen.findByRole('heading', { level: 1, name: 'November check-in' });
    expectFallback('What changed');
    expect(await screen.findByRole('region', { name: 'Net worth' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Coming up' })).toBeInTheDocument();
  });

  it('leaves the decisions and the calendar on the plan', async () => {
    render(<PlanScreen />);
    await screen.findByRole('list', { name: 'Saved decisions' });
    expectFallback('Export');
    expect(screen.getByRole('region', { name: 'Next 90 days' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your paycheck' })).toBeInTheDocument();
  });

  it('tries the card again from its own button', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PlanScreen />);
    await screen.findByRole('list', { name: 'Saved decisions' });
    await user.click(
      within(screen.getByRole('region', { name: 'Export' })).getByRole('button', {
        name: 'Try again',
      }),
    );
    // Still broken: the boundary catches it again rather than taking the page down.
    expectFallback('Export');
    expect(screen.getByRole('region', { name: 'Next 90 days' })).toBeInTheDocument();
  });
});
