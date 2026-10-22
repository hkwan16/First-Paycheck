'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarSmallIcon, DownloadIcon, RefreshIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { JobProgress } from '@/components/ui/JobProgress';
import { Notice } from '@/components/ui/Notice';
import { apiErrorCode, apiErrorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { useDownloadCalendar, useDownloadPlanPdf, useExportPlan } from '@/lib/api/hooks';

const PROGRESS_LABEL = 'Preparing your PDF';

/**
 * The mockup's "Download PDF" and "Add to calendar": the PDF is made by a
 * background job (`POST /plan/export`), followed until it succeeds, then
 * downloaded; a dead job offers Try again. The calendar file downloads at
 * once. Both are fetched with the session token and saved as files.
 */
export function ExportCard() {
  const exporter = useExportPlan();
  const pdf = useDownloadPlanPdf();
  const calendar = useDownloadCalendar();
  const [last, setLast] = useState<'pdf' | 'calendar' | null>(null);

  // Download each export once, as soon as its job has succeeded.
  const downloaded = useRef<string | null>(null);
  const { jobId, pdfUrl } = exporter;
  const { mutate: downloadPdf } = pdf;
  useEffect(() => {
    if (jobId === null || pdfUrl === null || downloaded.current === jobId) return;
    downloaded.current = jobId;
    setLast('pdf');
    downloadPdf(jobId);
  }, [jobId, pdfUrl, downloadPdf]);

  const startExport = () => {
    pdf.reset();
    exporter.start();
  };

  const retryPdf = () => {
    // A 404 means the export is gone (older than 7 days): make a new one.
    if (jobId === null || apiErrorCode(pdf.error) === 'not_found') startExport();
    else downloadPdf(jobId);
  };

  const saveCalendar = () => {
    setLast('calendar');
    calendar.mutate();
  };

  const job = exporter.job;
  const following = jobId !== null && !pdf.isSuccess && !pdf.isError;
  const busy = exporter.isStarting || (following && !job.isFailed);

  let message = '';
  if (last === 'pdf' && pdf.isSuccess) message = `Downloaded ${pdf.data}.`;
  if (last === 'calendar' && calendar.isSuccess) {
    message = `Downloaded ${calendar.data}. Open it to add every decision date to your calendar app.`;
  }

  return (
    <Card aria-labelledby="export-title" gap={14}>
      <div>
        <h2 id="export-title" className="m-0">
          Export
        </h2>
        <p className="m-0 text-small text-ink-3">
          A printable copy of this plan, and every decision date for your calendar app.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" onClick={startExport} loading={busy}>
          <DownloadIcon />
          Download PDF
        </Button>
        <Button onClick={saveCalendar} loading={calendar.isPending}>
          <CalendarSmallIcon size={16} />
          Add to calendar (.ics)
        </Button>
      </div>

      {exporter.startError !== null && !exporter.isStarting && (
        <Notice tone="warning" compact role="alert">
          Could not start the PDF.{' '}
          {apiErrorMessage(exporter.startError, 'The server could not be reached. Try again.')}
        </Notice>
      )}
      {following && (
        <JobProgress
          label={PROGRESS_LABEL}
          job={job.data}
          failed={job.isFailed}
          failedMessage="Nothing was saved."
          onRetry={startExport}
          retrying={exporter.isStarting}
        />
      )}
      {pdf.isError && (
        <Notice tone="warning" compact role="alert" className="items-center">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span>
              Could not download your PDF.{' '}
              {apiErrorMessage(pdf.error, 'The server could not be reached.')}
            </span>
            <Button size="sm" onClick={retryPdf}>
              <RefreshIcon />
              Try again
            </Button>
          </div>
        </Notice>
      )}
      {calendar.isError && (
        <Notice tone="warning" compact role="alert">
          Could not download your calendar.{' '}
          {apiErrorMessage(calendar.error, 'The server could not be reached. Try again.')}
        </Notice>
      )}
      {/* Always rendered, so the polite region exists before its text arrives. */}
      <p role="status" className={cn('m-0 text-small', message ? 'text-ink-3' : 'sr-only')}>
        {message}
      </p>
      {last === 'pdf' && pdf.isSuccess && jobId !== null && (
        <div>
          <Button size="sm" onClick={() => downloadPdf(jobId)}>
            <DownloadIcon />
            Download again
          </Button>
        </div>
      )}
    </Card>
  );
}
