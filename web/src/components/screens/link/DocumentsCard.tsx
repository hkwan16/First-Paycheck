'use client';

import { useId, useRef, useState } from 'react';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DropZone } from '@/components/ui/DropZone';
import { ListRows } from '@/components/ui/ListRows';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiErrorMessage } from '@/lib/api/errors';
import { useDocuments, useExtractDocument, useUploadDocument } from '@/lib/api/hooks';
import type { DocumentSummary, DocumentType } from '@/lib/api/types';
import { DOCUMENT_ACCEPT, DocumentRow, READABLE_TYPES } from './DocumentRow';
import { documentTypeLabel } from '@/lib/documents';
import { rejectedFileMessage, uploadErrorMessage } from './document-format';

interface Upload {
  key: number;
  name: string;
  /** Whole percent of the file sent. */
  percent: number;
}

interface Alert {
  key: number;
  message: string;
  /**
   * What it is about: an upload, or reading one document (its id). A newer
   * action of the same kind supersedes it (issue 240): choosing files drops
   * every upload warning, reading a document again drops that one's.
   */
  about: 'upload' | { read: string };
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

function LoadingRows() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3.5">
      <span className="sr-only">Loading your documents</span>
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-3">
          <Skeleton block className="size-9 rounded-control" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="w-40" />
            <Skeleton className="w-56 text-small" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The mockup's "Documents" card: the upload control, then the uploads in
 * flight and each document with where it is in being read and checked. The
 * control sits above the list (newest first), so what an upload does appears
 * right under it (issue 208). An upload is read as soon as it lands, and its
 * job is followed until the document is ready to check. Until the list has
 * loaded it shows loading rows, never "No documents yet" (issue 196).
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

  const alert = (message: string, about: Alert['about']) =>
    setAlerts((current) => [...current, { key: ++sequence.current, message, about }]);
  const supersede = (about: Alert['about']) =>
    setAlerts((current) =>
      current.filter((a) =>
        about === 'upload'
          ? a.about !== 'upload'
          : a.about === 'upload' || a.about.read !== about.read,
      ),
    );

  const read = async (documentId: string, documentType: DocumentType) => {
    supersede({ read: documentId });
    setStarting((current) => new Set(current).add(documentId));
    setJobs(({ [documentId]: _previous, ...rest }) => rest);
    try {
      const { job_id } = await extract.mutateAsync(documentId);
      setJobs((current) => ({ ...current, [documentId]: job_id }));
    } catch (error) {
      alert(
        `Could not start reading the ${documentTypeLabel(documentType).toLowerCase()}. ${apiErrorMessage(error, 'Try again.')}`,
        { read: documentId },
      );
    } finally {
      setStarting((current) => {
        const next = new Set(current);
        next.delete(documentId);
        return next;
      });
    }
  };

  /** Upload a file; `replaces` names the document a row's Replace retires with it. */
  const send = async (file: File, documentType: DocumentType, replaces?: string) => {
    const key = ++sequence.current;
    const setPercent = (percent: number) =>
      setUploads((current) => current.map((u) => (u.key === key ? { ...u, percent } : u)));
    setUploads((current) => [...current, { key, name: file.name, percent: 0 }]);
    try {
      const { document_id } = await upload.mutateAsync({
        file,
        type: documentType,
        replaces,
        onProgress: setPercent,
      });
      if (READABLE_TYPES.has(documentType)) void read(document_id, documentType);
    } catch (error) {
      alert(uploadErrorMessage(file.name, error), 'upload');
    } finally {
      setUploads((current) => current.filter((u) => u.key !== key));
    }
  };

  let body;
  if (documents.isPending) {
    body = <LoadingRows />;
  } else if (documents.isError) {
    body = (
      <Notice tone="warning" compact role="alert" className="items-center">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            Could not load your documents.{' '}
            {apiErrorMessage(documents.error, 'Check your connection.')}
          </span>
          <Button size="sm" onClick={() => void documents.refetch()}>
            Try again
          </Button>
        </div>
      </Notice>
    );
  } else if (list.length === 0 && uploads.length === 0) {
    body = (
      <p className="m-0 text-small text-ink-3">
        No documents yet. Your pay stub sets your pay and deductions; a benefits summary sets your
        health plans and 401(k) match.
      </p>
    );
  } else {
    body = (
      <ListRows>
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
            onReplace={(d, file) => {
              supersede('upload');
              void send(file, d.type, d.id);
            }}
          />
        ))}
      </ListRows>
    );
  }

  return (
    <Card aria-labelledby="docs-title">
      <h2 id="docs-title" className="m-0">
        Documents
      </h2>
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
          onFiles={(files) => {
            supersede('upload');
            files.forEach((file) => void send(file, type));
          }}
          onReject={(files) => {
            // Runs right after onFiles for one choice, so it keeps that choice's uploads.
            supersede('upload');
            files.forEach((file) => alert(rejectedFileMessage(file.name), 'upload'));
          }}
          title={list.length > 0 ? 'Add another document' : 'Add a document'}
          hint="PDF, PNG or JPEG. A photo or a scan works too."
        />
      </div>
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
      {body}
      <Notice>
        <span className="text-small">
          <strong>We hide your Social Security and account numbers before we read a page.</strong>{' '}
          If we cannot hide them on a page, we skip that page and you type what it shows. We delete
          each file once you confirm what we read.
        </span>
      </Notice>
    </Card>
  );
}
