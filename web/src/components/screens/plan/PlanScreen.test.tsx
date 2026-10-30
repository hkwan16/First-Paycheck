import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS } from '@/lib/api/hooks';
import { watchDownloads } from '@/test/fake-download';
import { DECISION_V1_ID } from '@/test/fixtures/decisions';
import {
  CALENDAR_FILENAME,
  emptyPlan,
  exportJob,
  exportJobId,
  exportJobStates,
  partialPlan,
  planDecision,
  PLAN_PDF_FILENAME,
  samplePlan,
} from '@/test/fixtures/plan';
import {
  HEALTH_DECISION_ID,
  sampleHealthDecision,
  sampleHealthPlans,
} from '@/test/fixtures/planning';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { W4_DECISION_ID } from '@/test/fixtures/w4';
import { apiUrl, scriptJob } from '@/test/msw/handlers';
import { planDb } from '@/test/msw/plan-handlers';
import { server } from '@/test/msw/server';
import { act, renderWithProviders, screen, waitFor, within } from '@/test/render';
import { PlanScreen } from './PlanScreen';

/** `METHOD /path` of every request, in order. */
function requests() {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  return seen;
}

let downloads: ReturnType<typeof watchDownloads>;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) });
  downloads = watchDownloads();
});
afterEach(() => {
  downloads.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
  server.events.removeAllListeners();
});

const render = () => renderWithProviders(<PlanScreen />, { advanceTimers: vi.advanceTimersByTime });

async function open() {
  const view = render();
  await screen.findByRole('heading', { level: 1, name: 'Your plan, on one page' });
  await screen.findByText(/decisions saved$/);
  return view;
}

const region = (name: string) => screen.getByRole('region', { name });
/** A figure's value, by its label, in a decision's summary. */
const figure = (card: HTMLElement, label: string) =>
  within(card).getByText(label, { selector: 'dt' }).nextElementSibling;

describe('PlanScreen with every decision saved', () => {
  it('says the plan is whole and shows one summary per decision, in calculator order', async () => {
    await open();
    expect(screen.getByText('4 of 4 decisions saved')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Still to decide' })).toBeNull();
    const decisions = screen.getByRole('list', { name: 'Saved decisions' });
    expect(
      within(decisions)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Emergency fund', '401(k) match', 'Health plan', 'W-4, federal only']);
  });

  it("shows each decision's figures by the API's labels, formatted and nothing more", async () => {
    await open();
    const fund = region('Emergency fund');
    expect(figure(fund, 'Target')).toHaveTextContent('$5,469.75');
    expect(figure(fund, 'Monthly contribution')).toHaveTextContent('$300.00');
    expect(figure(fund, 'Funded today')).toHaveTextContent('39.12%');
    const k401 = region('401(k) match');
    expect(figure(k401, 'Your contribution')).toHaveTextContent('4%');
    expect(figure(k401, 'Employer match a year')).toHaveTextContent('$2,600.00');
    expect(figure(k401, 'Match missed a year')).toHaveTextContent('$0.00');
    expect(within(k401).getByText('v1 · Saved Oct 17, 2026')).toBeInTheDocument();
    const health = region('Health plan');
    expect(figure(health, 'Plan')).toHaveTextContent('Gold PPO');
    expect(figure(health, 'Expected cost a year at medium use')).toHaveTextContent('$2,025.00');
    const w4 = region('W-4, federal only');
    expect(figure(w4, 'Federal withholding per paycheck')).toHaveTextContent('$213.67');
    expect(figure(w4, 'Projected refund (negative is owed)')).toHaveTextContent('$0.08');
  });

  it('says a health plan that comes out ahead is that much ahead, with no minus sign', async () => {
    // Saver HDHP at low use: the API's low cost is negative (spec 012 rule 17).
    const { inputs, result } = sampleHealthPlans({ expected_usage: 'low', selected_plan_index: 2 });
    const plan = samplePlan();
    plan.decisions[2] = planDecision(
      sampleHealthDecision({ inputs: structuredClone(inputs), result: structuredClone(result) }),
    );
    planDb.plan = plan;
    await open();
    const health = region('Health plan');
    expect(figure(health, 'Plan')).toHaveTextContent('Saver HDHP');
    expect(figure(health, 'Expected cost a year at low use')).toHaveTextContent('$260.00 ahead');
    expect(figure(health, 'Worst case a year')).toHaveTextContent('$5,740.00');
    expect(health).not.toHaveTextContent('-$');
  });

  it("gives each explanation's status: verified, fallback, not written, or none for this calculator", async () => {
    await open();
    expect(
      within(region('401(k) match')).getByRole('link', { name: 'Verified explanation' }),
    ).toHaveAttribute('href', `/why/${DECISION_V1_ID}`);
    expect(
      within(region('Health plan')).getByRole('link', { name: 'See the calculator’s result' }),
    ).toHaveAttribute('href', `/why/${HEALTH_DECISION_ID}`);
    const w4 = region('W-4, federal only');
    expect(within(w4).getByText(/Explanation not written yet\./)).toBeInTheDocument();
    expect(within(w4).getByRole('link', { name: 'Write it' })).toHaveAttribute(
      'href',
      `/why/${W4_DECISION_ID}`,
    );
    expect(within(region('Emergency fund')).queryByText(/explanation/i)).toBeNull();
  });

  it('shows the pay stub the plan is built on', async () => {
    await open();
    const paycheck = region('Your paycheck');
    expect(within(paycheck).getByText(/Acme Corp · paid Oct 15, 2026/)).toBeInTheDocument();
    expect(within(paycheck).getByText('Gross pay').parentElement).toHaveTextContent('$2,708.33');
    expect(within(paycheck).getByText('Take-home pay').parentElement).toHaveTextContent(
      '$1,996.04',
    );
    expect(figure(paycheck, 'Federal withholding')).toHaveTextContent('$297.76');
    expect(figure(paycheck, 'Medical premium')).toHaveTextContent('$62.50');
  });

  it('shows the goals with their status and progress', async () => {
    await open();
    const goals = region('Goals');
    const goal = within(goals).getByRole('listitem');
    expect(within(goal).getByText('Emergency fund')).toBeInTheDocument();
    expect(within(goal).getByText('Active')).toBeInTheDocument();
    expect(goal).toHaveTextContent('$300.00 a month toward $5,469.75');
    expect(goal).toHaveTextContent('By Sep 30, 2027');
    expect(
      within(goal).getByRole('progressbar', { name: 'Emergency fund progress' }),
    ).toHaveAttribute('aria-valuetext', '39.12% of the target');
  });

  it('lists the next 90 days of the calendar in the API’s order', async () => {
    await open();
    const calendar = region('Next 90 days');
    expect(within(calendar).getByText(/Through Jan 15, 2027/)).toBeInTheDocument();
    const items = within(calendar).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('div.font-semibold')?.textContent)).toEqual([
      'Check that your next pay stub shows your new 401(k) contribution',
      'Make your first emergency fund contribution',
      'Give your employer your updated Form W-4',
      'Health plan enrollment deadline',
    ]);
    expect(items[3]).toHaveTextContent('Due Nov 14, 2026');
  });

  it("links each date's badge to its decision's step (spec 018 rule 4)", async () => {
    await open();
    const calendar = region('Next 90 days');
    expect(
      within(calendar)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['401(k) match', '/setup/decisions/401k'],
      ['Emergency fund', '/setup/decisions/emergency-fund'],
      ['W-4, federal only', '/setup/decisions/w4'],
      ['Health plan', '/setup/decisions/health-plan'],
    ]);
  });

  it('goes back to the last decision step', async () => {
    await open();
    expect(screen.getByRole('link', { name: 'Back to decisions' })).toHaveAttribute(
      'href',
      '/setup/decisions/w4',
    );
  });
});

describe('PlanScreen with some decisions saved', () => {
  it('counts what is saved and links each missing calculator to its card', async () => {
    planDb.plan = partialPlan();
    await open();
    expect(screen.getByText('1 of 4 decisions saved')).toBeInTheDocument();
    const missing = screen.getByRole('list', { name: 'Still to decide' });
    expect(
      within(missing)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Emergency fund', '/setup/decisions/emergency-fund'],
      ['Health plan', '/setup/decisions/health-plan'],
      ['W-4, federal only', '/setup/decisions/w4'],
    ]);
    expect(screen.getAllByRole('heading', { level: 2, name: '401(k) match' })).toHaveLength(1);
    expect(within(region('Goals')).getByText(/No goals yet/)).toBeInTheDocument();
  });
});

describe('PlanScreen with nothing saved', () => {
  it('sends the person to Decisions, with nothing to export', async () => {
    planDb.plan = emptyPlan();
    render();
    expect(await screen.findByText('No decisions saved yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to decisions' })).toHaveAttribute(
      'href',
      '/setup/decisions/emergency-fund',
    );
    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull();
  });
});

describe('PlanScreen when the plan cannot be read', () => {
  it('says so', async () => {
    server.use(
      http.get(apiUrl('/plan'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Something went wrong.' } },
          { status: 500 },
        ),
      ),
    );
    render();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  });
});

describe('PlanScreen export', () => {
  it('prepares the PDF, shows the job, then downloads it', async () => {
    scriptJob(exportJobStates(exportJobId(1)));
    const seen = requests();
    const { user } = await open();
    const exportCard = region('Export');

    await user.click(within(exportCard).getByRole('button', { name: 'Download PDF' }));
    const bar = await within(exportCard).findByRole('progressbar', { name: 'Preparing your PDF' });
    expect(bar).toBeInTheDocument();
    // "Starting" until the job's first read answers.
    expect(await within(exportCard).findByText('Waiting to start')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() =>
      expect(downloads.clicks.map((c) => c.download)).toEqual([PLAN_PDF_FILENAME]),
    );
    expect(await within(exportCard).findByText(`Downloaded ${PLAN_PDF_FILENAME}.`)).toBeVisible();
    expect(seen).toContain('POST /plan/export');
    expect(seen).toContain(`GET /plan/export/${exportJobId(1)}`);

    // The same PDF again, without a new export.
    await user.click(within(exportCard).getByRole('button', { name: 'Download again' }));
    await waitFor(() => expect(downloads.clicks).toHaveLength(2));
    expect(seen.filter((r) => r === 'POST /plan/export')).toHaveLength(1);
  });

  it('offers Try again when the export dies, and the retry downloads', async () => {
    scriptJob([exportJob(exportJobId(1), { status: 'dead', last_error: 'WeasyPrint failed' })]);
    const { user } = await open();
    const exportCard = region('Export');

    await user.click(within(exportCard).getByRole('button', { name: 'Download PDF' }));
    const alert = await within(exportCard).findByRole('alert');
    expect(alert).toHaveTextContent('Preparing your PDF did not finish.');
    expect(downloads.clicks).toEqual([]);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(downloads.clicks.map((c) => c.download)).toEqual([PLAN_PDF_FILENAME]),
    );
    expect(within(exportCard).queryByRole('alert')).toBeNull();
  });

  it('says when the finished PDF cannot be downloaded, and tries again', async () => {
    let refused = true;
    server.use(
      http.get(apiUrl('/plan/export/:id'), () =>
        refused
          ? HttpResponse.json(
              { error: { code: 'internal_error', message: 'Something went wrong.' } },
              { status: 500 },
            )
          : undefined,
      ),
    );
    const { user } = await open();
    const exportCard = region('Export');
    await user.click(within(exportCard).getByRole('button', { name: 'Download PDF' }));
    const alert = await within(exportCard).findByRole('alert');
    expect(alert).toHaveTextContent('Could not download your PDF. Something went wrong.');

    refused = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(downloads.clicks).toHaveLength(1));
  });

  it('says when the export cannot start', async () => {
    server.use(
      http.post(apiUrl('/plan/export'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Something went wrong.' } },
          { status: 500 },
        ),
      ),
    );
    const { user } = await open();
    const exportCard = region('Export');
    await user.click(within(exportCard).getByRole('button', { name: 'Download PDF' }));
    expect(await within(exportCard).findByRole('alert')).toHaveTextContent(
      'Could not start the PDF. Something went wrong.',
    );
  });
});

describe('PlanScreen calendar file', () => {
  it('downloads the .ics and says so', async () => {
    const { user } = await open();
    const exportCard = region('Export');
    await user.click(within(exportCard).getByRole('button', { name: 'Add to calendar (.ics)' }));
    await waitFor(() =>
      expect(downloads.clicks.map((c) => c.download)).toEqual([CALENDAR_FILENAME]),
    );
    expect(
      await within(exportCard).findByText(`Downloaded ${CALENDAR_FILENAME}.`, { exact: false }),
    ).toBeVisible();
  });

  it('says when the file cannot be downloaded', async () => {
    server.use(
      http.get(apiUrl('/plan/calendar.ics'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Something went wrong.' } },
          { status: 500 },
        ),
      ),
    );
    const { user } = await open();
    const exportCard = region('Export');
    await user.click(within(exportCard).getByRole('button', { name: 'Add to calendar (.ics)' }));
    expect(await within(exportCard).findByRole('alert')).toHaveTextContent(
      'Could not download your calendar. Something went wrong.',
    );
  });
});
