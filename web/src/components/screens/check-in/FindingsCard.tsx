'use client';

import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { apiErrorMessage } from '@/lib/api/errors';
import { useUpdateFinding, type UpdateFindingVariables } from '@/lib/api/hooks';
import type { CheckInDetail } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { handledText } from './checkin-format';
import { FindingRow } from './FindingRow';

const ANNOUNCE: Record<UpdateFindingVariables['type'], string> = {
  done: 'Marked done',
  dismiss: 'Dismissed',
  undo: 'Back to open',
};

/**
 * "What changed": the check-in's findings in the API's order. Done, Dismiss
 * and Undo show at once (`useUpdateFinding` is optimistic), focus stays on
 * the row's action button as it swaps, and a refused change goes back with a
 * notice saying so.
 */
export function FindingsCard({ checkIn }: { checkIn: CheckInDetail }) {
  const [failure, setFailure] = useState<string | null>(null);
  /** Each finding's title as shown when it was last changed, for the failure notice. */
  const titles = useRef(new Map<string, string>());
  const [announcement, setAnnouncement] = useState('');
  /**
   * The row whose action button takes focus once it renders in the given
   * state: Undo after Done or Dismiss, Done after Undo or a rollback.
   */
  const focusAfter = useRef<{ findingId: string; handled: boolean } | null>(null);
  const completed = checkIn.status === 'completed';

  const update = useUpdateFinding(checkIn.id, {
    onError: (error, { findingId, type }) => {
      focusAfter.current = { findingId, handled: type === 'undo' };
      setFailure(
        `Could not save “${titles.current.get(findingId)}”. It is back to how it was. ${apiErrorMessage(error, 'Try again.')}`,
      );
    },
  });

  const onAction = (variables: UpdateFindingVariables, title: string) => {
    const handled = variables.type !== 'undo';
    setFailure(null);
    focusAfter.current = { findingId: variables.findingId, handled };
    titles.current.set(variables.findingId, title);
    setAnnouncement(`${ANNOUNCE[variables.type]}: ${title}`);
    update.mutate(variables);
  };

  return (
    <Card aria-labelledby="findings-title" gap={14}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="findings-title" className="m-0">
          What changed
        </h2>
        {checkIn.finding_count > 0 && (
          <Badge tone={completed ? 'confirmed' : 'neutral'}>
            <span className="tabular-nums">{handledText(checkIn)}</span>
          </Badge>
        )}
      </div>
      {completed && checkIn.completed_at && (
        <Notice tone="confirmed" compact>
          Every finding is handled. Completed {formatDate(checkIn.completed_at)}.
        </Notice>
      )}
      {checkIn.findings.length === 0 ? (
        <p className="m-0 text-small text-ink-3">
          Nothing changed against your plan this month. The check-in looks again whenever new pay
          stubs or transactions arrive.
        </p>
      ) : (
        <ul aria-label="Findings" className="m-0 flex list-none flex-col p-0">
          {checkIn.findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              onAction={onAction}
              actionRef={(element, handled) => {
                const target = focusAfter.current;
                if (element && target?.findingId === finding.id && target.handled === handled) {
                  focusAfter.current = null;
                  element.focus();
                }
              }}
            />
          ))}
        </ul>
      )}
      {failure && (
        <Notice tone="warning" compact role="alert">
          {failure}
        </Notice>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </Card>
  );
}
