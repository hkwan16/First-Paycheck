'use client';

import { CheckIcon, DocumentIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { DropZone } from '@/components/ui/DropZone';
import { IconTile } from '@/components/ui/IconTile';
import { ListRows } from '@/components/ui/ListRows';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { type DocumentSummary, useDocuments } from '@/lib/api/pending';
import { formatNumber } from '@/lib/money';

const KIND_LABEL: Record<DocumentSummary['kind'], string> = {
  pay_stub: 'Pay stub',
  offer_letter: 'Offer letter',
  benefits: 'Benefits summary',
};

function DocumentRow({ doc }: { doc: DocumentSummary }) {
  const pages =
    doc.page_count === null
      ? null
      : `${formatNumber(doc.page_count)} ${doc.page_count === 1 ? 'page' : 'pages'}`;
  const redacted = doc.redaction_count ?? 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <IconTile tone={doc.kind === 'benefits' ? 'plum' : 'coral'}>
          <DocumentIcon />
        </IconTile>
        <div className="min-w-0">
          <div className="font-semibold">{KIND_LABEL[doc.kind]}</div>
          <div className="text-small break-all text-ink-3">
            {doc.filename}
            {pages && ` \u00b7 ${pages}`}
            {' \u00b7 uploaded '}
            <RelativeTime value={doc.created_at} />
          </div>
        </div>
      </div>
      {doc.redaction_count !== null && (
        <Badge
          tone={redacted > 0 ? 'coral' : 'neutral'}
          icon={redacted > 0 ? <CheckIcon /> : undefined}
        >
          {formatNumber(redacted)} {redacted === 1 ? 'item' : 'items'} redacted
        </Badge>
      )}
    </div>
  );
}

/**
 * The mockup's "Documents" card. Uploads arrive with the Confirm screen
 * (`POST /docs`); until then the list reads the pending `useDocuments` hook,
 * which has no data, and the drop zone is shown but disabled.
 */
export function DocumentsCard() {
  const documents = useDocuments() ?? [];

  return (
    <Card aria-labelledby="docs-title">
      <h2 id="docs-title" className="m-0">
        Documents
      </h2>
      <ListRows>
        {documents.length === 0 ? (
          <p className="m-0 text-small text-ink-3">
            No documents yet. Your pay stub or offer letter sets your income and deductions; a
            benefits summary sets your health plan and 401(k) match.
          </p>
        ) : (
          documents.map((doc) => <DocumentRow key={doc.id} doc={doc} />)
        )}
        <div>
          <DropZone
            accept=".pdf,.png,.jpg,.jpeg"
            onFiles={() => {}}
            disabled
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                Add a pay stub or benefits summary <Badge>Coming next</Badge>
              </span>
            }
            hint="PDF, PNG or JPEG. Scanned pages are read with OCR."
          />
        </div>
      </ListRows>
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
