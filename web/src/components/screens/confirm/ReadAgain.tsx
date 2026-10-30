'use client';

import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { apiErrorMessage } from '@/lib/api/errors';
import { useExtractDocument } from '@/lib/api/hooks';
import type { DocumentSummary } from '@/lib/api/types';
import { documentTypeLabel } from '@/lib/documents';

/**
 * Read again (spec 004 rules 32-34): for a document that went to manual entry
 * because the AI was unavailable, which the API says with `can_read_again`.
 * Starting it refreshes the document, which then shows as being read.
 */
export function ReadAgain({ document }: { document: DocumentSummary }) {
  const extract = useExtractDocument();
  const noun = documentTypeLabel(document.type).toLowerCase();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button size="sm" loading={extract.isPending} onClick={() => extract.mutate(document.id)}>
          Read again
        </Button>
      </div>
      {extract.isError && (
        <Notice tone="warning" compact role="alert">
          Could not start reading the {noun}.{' '}
          {apiErrorMessage(extract.error, 'Check your connection and try again.')}
        </Notice>
      )}
    </div>
  );
}
