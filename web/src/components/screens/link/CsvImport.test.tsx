import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS } from '@/lib/api/hooks';
import { API_BASE_URL } from '@/lib/api/base-url';
import { installFakeXhr } from '@/test/fake-xhr';
import { CHECKING_ID, SAMPLE_NOW, sampleAccounts, sampleJob } from '@/test/fixtures/sample';
import { scriptJob } from '@/test/msw/handlers';
import { act, renderWithProviders, screen, userEvent, waitFor, within } from '@/test/render';
import { CsvImport } from './CsvImport';

const csv = (name = 'export.csv') =>
  new File(['Date,Description,Amount\n2026-10-01,NETFLIX.COM,-15.49\n'], name, {
    type: 'text/csv',
  });

const region = () => screen.getByRole('region', { name: 'Import a CSV' });
const poll = () => act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));

function jobStates(id: string, kind: 'categorize.run' | 'recurring.detect') {
  return [
    sampleJob({ id, kind, status: 'queued', progress: 0 }),
    sampleJob({ id, kind, status: 'succeeded', progress: 100, finished_at: SAMPLE_NOW }),
  ];
}

const IMPORTED = {
  account: { ...sampleAccounts[0]!, id: 'acct-csv', name: 'Credit union', mask: null },
  imported: 3,
  categorize_job_id: '5a000000-0000-4000-8000-0000000000c1',
  recurring_job_id: '5a000000-0000-4000-8000-0000000000c2',
};

function setup() {
  const xhr = installFakeXhr();
  const rendered = renderWithProviders(<CsvImport />, { advanceTimers: vi.advanceTimersByTime });
  return { xhr, ...rendered };
}

async function chooseAndImport(user: ReturnType<typeof setup>['user'], file = csv()) {
  await user.upload(within(region()).getByLabelText(/Choose a CSV file/), file);
  await user.click(within(region()).getByRole('button', { name: 'Import CSV' }));
}

describe('CsvImport', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds the import until a file is chosen', async () => {
    setup();
    expect(within(region()).getByRole('button', { name: 'Import CSV' })).toBeDisabled();
  });

  it('imports into a new account with the chosen sign, then follows both jobs', async () => {
    scriptJob(jobStates(IMPORTED.categorize_job_id, 'categorize.run'));
    scriptJob(jobStates(IMPORTED.recurring_job_id, 'recurring.detect'));
    const { xhr, user } = setup();
    await user.selectOptions(within(region()).getByLabelText('Account type'), 'Savings');
    await user.type(within(region()).getByLabelText('Account name (optional)'), 'Credit union');
    const sign = within(region()).getByRole('group', {
      name: 'Money going out shows in the file as',
    });
    expect(within(sign).getByRole('button', { name: 'Negative' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(sign).getByRole('button', { name: 'Positive' }));
    await chooseAndImport(user);

    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    const request = xhr.last();
    expect(request.url).toBe(`${API_BASE_URL}/accounts/import`);
    expect((request.field('file') as File).name).toBe('export.csv');
    expect(request.field('kind')).toBe('savings');
    expect(request.field('name')).toBe('Credit union');
    expect(request.field('sign')).toBe('positive_is_out');
    expect(request.field('account_id')).toBeNull();

    const bar = within(region()).getByRole('progressbar', { name: 'Uploading export.csv' });
    act(() => request.progress(1, 2));
    expect(bar).toHaveAttribute('aria-valuenow', '50');

    act(() => request.respond(200, IMPORTED));
    const imported = await within(region()).findByText(
      'Imported 3 transactions into Credit union.',
    );
    expect(imported.closest('[role="status"]')).not.toBeNull();
    expect(
      within(region()).getByRole('progressbar', { name: 'Labeling categories' }),
    ).toBeInTheDocument();
    expect(
      within(region()).getByRole('progressbar', { name: 'Finding recurring charges' }),
    ).toBeInTheDocument();

    await poll();
    await poll();
    await waitFor(() =>
      expect(within(region()).getAllByText('Done').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('adds to an account imported before, sending only its id', async () => {
    const { xhr, user } = setup();
    const target = within(region()).getByLabelText('Import into');
    await within(target).findByRole('option', { name: 'Chase Total Checking ··4821' });
    await user.selectOptions(target, 'Chase Total Checking ··4821');
    expect(within(region()).queryByLabelText('Account type')).not.toBeInTheDocument();
    await chooseAndImport(user);
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    expect(xhr.last().field('account_id')).toBe(CHECKING_ID);
    expect(xhr.last().field('kind')).toBeNull();
    expect(xhr.last().field('sign')).toBe('negative_is_out');
  });

  it('lists the row errors of a refused file, the first 50 and how many in all', async () => {
    const { xhr, user } = setup();
    await chooseAndImport(user);
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    const errors = Array.from({ length: 50 }, (_, i) => ({
      row: i + 2,
      column: 'amount',
      message: 'Not an amount with at most two decimal places',
    }));
    errors[0] = { row: 1, column: 'date', message: 'No date column (one of: date, posted date)' };
    errors[1] = { row: null, column: null, message: 'The file has no transactions' } as never;
    act(() =>
      xhr.last().respond(422, {
        error: {
          code: 'csv_invalid',
          message: 'The CSV has 73 problems',
          details: { errors, total: 73 },
        },
      }),
    );
    const alert = await within(region()).findByRole('alert');
    expect(alert).toHaveTextContent('The CSV has 73 problems. Nothing was imported.');
    const items = within(alert).getAllByRole('listitem');
    expect(items).toHaveLength(50);
    expect(items[0]).toHaveTextContent('Row 1, date: No date column (one of: date, posted date)');
    expect(items[1]).toHaveTextContent('The file: The file has no transactions');
    expect(items[2]).toHaveTextContent(
      'Row 4, amount: Not an amount with at most two decimal places',
    );
    expect(alert).toHaveTextContent('Showing the first 50 of 73.');
  });

  it('offers to try again after another import into the same account won', async () => {
    const { xhr, user } = setup();
    await chooseAndImport(user);
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    act(() =>
      xhr.last().respond(409, {
        error: {
          code: 'import_conflict',
          message: 'Another import into this account finished first; try again',
        },
      }),
    );
    const alert = await within(region()).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Another import into this account finished first. Try again: rows already imported are not added twice.',
    );
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(xhr.requests).toHaveLength(2));
    expect((xhr.last().field('file') as File).name).toBe('export.csv');
  });

  it("reports any other refusal in the API's words", async () => {
    const { xhr, user } = setup();
    await chooseAndImport(user);
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    act(() =>
      xhr.last().respond(422, {
        error: {
          code: 'not_csv_account',
          message: 'Only an account created by a CSV import can take another import',
        },
      }),
    );
    expect(await within(region()).findByRole('alert')).toHaveTextContent(
      'Could not import export.csv. Only an account created by a CSV import can take another import',
    );
  });

  it('refuses a file that is not a CSV without uploading it', async () => {
    // A drop is not filtered by the picker's accept list.
    const { xhr } = setup();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, applyAccept: false });
    await user.upload(
      within(region()).getByLabelText(/Choose a CSV file/),
      new File(['x'], 'stub.pdf', { type: 'application/pdf' }),
    );
    expect(await within(region()).findByRole('alert')).toHaveTextContent(
      'stub.pdf is not a CSV file. Export your transactions as CSV from your bank.',
    );
    expect(within(region()).getByRole('button', { name: 'Import CSV' })).toBeDisabled();
    expect(xhr.requests).toHaveLength(0);
  });
});
