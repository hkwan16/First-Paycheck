'use client';

import { useId, useState, type FormEvent } from 'react';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { DropZone } from '@/components/ui/DropZone';
import { Input } from '@/components/ui/Input';
import { JobProgress } from '@/components/ui/JobProgress';
import { Notice } from '@/components/ui/Notice';
import { Seg } from '@/components/ui/Seg';
import { Select } from '@/components/ui/Select';
import { ACCOUNT_KIND_LABELS, maskLabel } from '@/lib/accounts';
import { apiErrorMessage } from '@/lib/api/errors';
import { useAccounts, useImportCsv, useJob } from '@/lib/api/hooks';
import type { AccountKind, AmountSign, CsvImport as CsvImported } from '@/lib/api/types';
import { csvProblems, UploadError, type CsvImportTarget, type CsvProblem } from '@/lib/api/upload';
import { formatNumber } from '@/lib/money';

const CSV_ACCEPT = '.csv,text/csv';

const KINDS = Object.entries(ACCOUNT_KIND_LABELS) as [AccountKind, string][];

const SIGNS = [
  { value: 'negative_is_out', label: 'Negative' },
  { value: 'positive_is_out', label: 'Positive' },
] as const satisfies readonly { value: AmountSign; label: string }[];

/** "Row 3, date: ...", "Row 1: ...", "The file: ...". */
function problemText({ row, column, message }: CsvProblem): string {
  if (row === null) return `The file: ${message}`;
  return column ? `Row ${row}, ${column}: ${message}` : `Row ${row}: ${message}`;
}

function ImportJobs({ result }: { result: CsvImported }) {
  const categorize = useJob(result.categorize_job_id);
  const recurring = useJob(result.recurring_job_id);
  const noun = result.imported === 1 ? 'transaction' : 'transactions';
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="confirmed" compact role="status">
        Imported {formatNumber(result.imported)} {noun} into {result.account.name}.
      </Notice>
      <JobProgress
        label="Labeling categories"
        job={categorize.data}
        failed={categorize.isFailed}
        failedMessage="The transactions are imported; their categories can be fixed by hand."
        onRetry={categorize.refetch}
      />
      <JobProgress
        label="Finding recurring charges"
        job={recurring.data}
        failed={recurring.isFailed}
        failedMessage="The transactions are imported; recurring charges are found on the next sync."
        onRetry={recurring.refetch}
      />
    </div>
  );
}

function ImportError({
  error,
  fileName,
  onRetry,
}: {
  error: unknown;
  fileName: string;
  onRetry: () => void;
}) {
  const problems = csvProblems(error);
  if (problems) {
    return (
      <Notice tone="warning" compact role="alert">
        <div className="flex flex-col gap-2">
          <span>{apiErrorMessage(error, 'The CSV has problems')}. Nothing was imported.</span>
          <ul className="m-0 flex max-h-60 list-disc flex-col gap-0.5 overflow-y-auto pl-5">
            {problems.errors.map((problem, index) => (
              <li key={index}>{problemText(problem)}</li>
            ))}
          </ul>
          {problems.total > problems.errors.length && (
            <span>
              Showing the first {formatNumber(problems.errors.length)} of{' '}
              {formatNumber(problems.total)}.
            </span>
          )}
        </div>
      </Notice>
    );
  }
  if (error instanceof UploadError && error.code === 'import_conflict') {
    return (
      <Notice tone="warning" compact role="alert" className="items-center">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            Another import into this account finished first. Try again: rows already imported are
            not added twice.
          </span>
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </Notice>
    );
  }
  return (
    <Notice tone="warning" compact role="alert">
      Could not import {fileName}. {apiErrorMessage(error, 'Try again.')}
    </Notice>
  );
}

/**
 * Import a bank's CSV export (spec 010 part B) into a new account or one
 * imported before. The file goes over the same XHR upload path as documents,
 * through the same pipeline as a linked bank; the two jobs it queues
 * (categorizing, finding recurring charges) are followed until they finish.
 */
export function CsvImport({ id }: { id?: string }) {
  const titleId = useId();
  const targetId = useId();
  const kindId = useId();
  const nameId = useId();
  const institutionId = useId();
  const accounts = useAccounts().data ?? [];
  const upload = useImportCsv();

  const [file, setFile] = useState<File | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [accountId, setAccountId] = useState('');
  const [kind, setKind] = useState<AccountKind>('checking');
  const [name, setName] = useState('');
  const [institution, setInstitution] = useState('');
  const [sign, setSign] = useState<AmountSign>('negative_is_out');
  const [percent, setPercent] = useState(0);

  const start = () => {
    if (!file) return;
    const account: CsvImportTarget = accountId
      ? { id: accountId }
      : { kind, name, institutionName: institution };
    setPercent(0);
    upload.mutate({ file, account, sign, onProgress: setPercent });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    start();
  };

  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className="flex flex-col gap-3.5 rounded-tile bg-tile p-4"
    >
      <h3 id={titleId} className="m-0">
        Import a CSV
      </h3>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <DropZone
          accept={CSV_ACCEPT}
          onFiles={([chosen]) => {
            setRejected(null);
            setFile(chosen ?? null);
          }}
          onReject={([bad]) =>
            setRejected(
              `${bad?.name ?? 'That file'} is not a CSV file. Export your transactions as CSV from your bank.`,
            )
          }
          title={file ? `Choose a CSV file (now ${file.name})` : 'Choose a CSV file'}
          hint="Your bank's export with a date, a description, and an amount (or debit and credit) column."
        />
        {rejected && (
          <Notice tone="warning" compact role="alert">
            {rejected}
          </Notice>
        )}

        <div className="grid grid-cols-2 gap-3 max-nav:grid-cols-1">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={targetId} className="text-small font-semibold text-ink-2">
              Import into
            </label>
            <Select
              id={targetId}
              size="sm"
              value={accountId}
              onChange={(event) => setAccountId(event.currentTarget.value)}
            >
              <option value="">A new account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {[account.name, maskLabel(account.mask)].filter(Boolean).join(' ')}
                </option>
              ))}
            </Select>
          </div>
          {accountId === '' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={kindId} className="text-small font-semibold text-ink-2">
                Account type
              </label>
              <Select
                id={kindId}
                size="sm"
                value={kind}
                onChange={(event) => setKind(event.currentTarget.value as AccountKind)}
              >
                {KINDS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {accountId === '' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={nameId} className="text-small font-semibold text-ink-2">
                Account name (optional)
              </label>
              <Input
                id={nameId}
                size="sm"
                maxLength={100}
                value={name}
                placeholder={`${ACCOUNT_KIND_LABELS[kind]} (CSV)`}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </div>
          )}
          {accountId === '' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={institutionId} className="text-small font-semibold text-ink-2">
                Bank name (optional)
              </label>
              <Input
                id={institutionId}
                size="sm"
                maxLength={200}
                value={institution}
                onChange={(event) => setInstitution(event.currentTarget.value)}
              />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span aria-hidden="true" className="text-small font-semibold text-ink-2">
            Money going out shows in the file as
          </span>
          <Seg
            label="Money going out shows in the file as"
            options={SIGNS}
            className="self-start"
            value={sign}
            onChange={setSign}
          />
          <span className="text-tiny text-ink-3">
            Most banks export money out as negative amounts. Debit and credit columns are read
            either way.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={!file} loading={upload.isPending}>
            Import CSV
          </Button>
          <span className="text-small text-ink-3">
            Nothing here is sent to an AI model; unknown merchants are categorized like a linked
            bank&apos;s.
          </span>
        </div>
      </form>

      {upload.isPending && file && (
        <Bar label={`Uploading ${file.name}`} tone="blue" value={percent} />
      )}
      {upload.isError && file && (
        <ImportError error={upload.error} fileName={file.name} onRetry={start} />
      )}
      {upload.isSuccess && <ImportJobs key={upload.data.categorize_job_id} result={upload.data} />}
    </section>
  );
}
