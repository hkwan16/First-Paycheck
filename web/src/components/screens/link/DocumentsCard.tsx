'use client';

import { useId, useRef, useState } from 'react';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DropZone } from '@/components/ui/DropZone';
import { ListRows } from '@/components/ui/ListRows';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { apiErrorMessage } from '@/lib/api/errors';
import { useDocuments, useExtractDocument, useUploadDocument } from '@/lib/api/hooks';
import type { DocumentSummary, DocumentType } from '@/lib/api/types';
import { DOCUMENT_ACCEPT, DocumentRow, READABLE_TYPES } from './DocumentRow';
import { documentTypeLabel, rejectedFileMessage, uploadErrorMessage } from './document-format';

interface Upload {
  key: number;
  name: string;
  /** Whole percent of the file sent. */
  percent: number;
}

interface Alert {
  key: number;
  message: string;
}

/** The two kinds of upload the person picks between (the mockup's two rows). */
const UPLOAD_TYPES: readonly { value: DocumentType; label: string }[] = [
  { value: 'pay_stub', label: 'Pay stub or offer letter' },
  { value: 'benefits', label: 'Benefits summary' },
];

function UploadRow({ upload }: { upload: Upload }) {
  const label = `Uploading ${upload.name}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-small">
        <span className="min-w-0 font-semibold break-all">{label}</span>
        <span className="flex-none text-ink-3 tabular-nums">
          {upload.percent < 100 ? `${upload.percent}%` : 'Checking the file'}
        </span>
      </div>
      <Bar label={label} tone="blue" value={upload.percent} />
    </div>
  );
}

/**
 * The mockup's "Documents" card: each document's place in the pipeline, the
 * uploads in flight with their progress, and a drop zone. An upload is read
 * (extracted) as soon as it lands, and its job is followed until the
 * document is ready to review.
 */
export function DocumentsCard() {
  const typeId = useId();
  const [type, setType] = useState<DocumentType>('pay_stub');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  /** Extraction jobs this page started, by document id. */
  const [jobs, setJobs] = useState<Record<string, string>>({});
  /** Documents whose extraction is being requested. */
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  const sequence = useRef(0);

  const documents = useDocuments({ pollWhileExtracting: (d) => !(d.id in jobs) });
  const upload = useUploadDocument();
  const extract = useExtractDocument();
  const list = documents.data ?? [];

  const alert = (message: string) =>
    setAlerts((current) => [...current, { key: ++sequence.current, message }]);

  const read = async (documentId: string, documentType: DocumentType) => {
    setStarting((current) => new Set(current).add(documentId));
    setJobs(({ [documentId]: _previous, ...rest }) => rest);
    try {
      const { job_id } = await extract.mutateAsync(documentId);
      setJobs((current) => ({ ...current, [documentId]: job_id }));
    } catch (error) {
      alert(
        `Could not start reading the ${documentTypeLabel(documentType).toLowerCase()}. ${apiErrorMessage(error, 'Try again.')}`,
      );
    } finally {
      setStarting((current) => {
        const next = new Set(current);
        next.delete(documentId);
        return next;
      });
    }
  };

  const send = async (file: File, documentType: DocumentType) => {
    const key = ++sequence.current;
    const setPercent = (percent: number) =>
      setUploads((current) => current.map((u) => (u.key === key ? { ...u, percent } : u)));
    setUploads((current) => [...current, { key, name: file.name, percent: 0 }]);
    try {
      const { document_id } = await upload.mutateAsync({
        file,
        type: documentType,
        onProgress: setPercent,
      });
      if (READABLE_TYPES.has(documentType)) void read(document_id, documentType);
    } catch (error) {
      alert(uploadErrorMessage(file.name, error));
    } finally {
      setUploads((current) => current.filter((u) => u.key !== key));
    }
  };

  return (
    <Card aria-labelledby="docs-title">
      <h2 id="docs-title" className="m-0">
        Documents
      </h2>
      <ListRows>
        {list.length === 0 && uploads.length === 0 && (
          <p className="m-0 text-small text-ink-3">
            No documents yet. Your pay stub or offer letter sets your income and deductions; a
            benefits summary sets your health plan and 401(k) match.
          </p>
        )}
        {uploads.map((u) => (
          <UploadRow key={u.key} upload={u} />
        ))}
        {list.map((doc: DocumentSummary) => (
          <DocumentRow
            key={doc.id}
            doc={doc}
            jobId={jobs[doc.id]}
            starting={starting.has(doc.id)}
            onRead={(d) => void read(d.id, d.type)}
            onReplace={(d, file) => void send(file, d.type)}
          />
        ))}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor={typeId} className="text-small font-semibold text-ink-2">
              Document type
            </label>
            <Select
              id={typeId}
              size="sm"
              className="w-auto"
              value={type}
              onChange={(event) => setType(event.currentTarget.value as DocumentType)}
            >
              {UPLOAD_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <DropZone
            accept={DOCUMENT_ACCEPT}
            multiple
            onFiles={(files) => files.forEach((file) => void send(file, type))}
            onReject={(files) => files.forEach((file) => alert(rejectedFileMessage(file.name)))}
            title={list.length > 0 ? 'Add another document' : 'Add a document'}
            hint="PDF, PNG or JPEG. Scanned pages are read with OCR."
          />
        </div>
      </ListRows>
      {alerts.map((a) => (
        <Notice key={a.key} tone="warning" compact role="alert" className="items-center">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span>{a.message}</span>
            <Button
              size="sm"
              onClick={() => setAlerts((current) => current.filter((x) => x.key !== a.key))}
            >
              Dismiss
            </Button>
          </div>
        </Notice>
      ))}
      <Notice>
        <span className="text-small">
          <strong>Before any AI sees a page, SSNs and account numbers are blacked out.</strong> Text
          PDFs are redacted as text; scanned pages are redacted in the image itself. Pages where OCR
          cannot redact safely are never sent, and you type those fields yourself. The original
          files are deleted as soon as you confirm the extracted fields.
        </span>
      </Notice>
    </Card>
  );
}
