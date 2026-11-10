import { useId } from 'react';
import { Notice } from '@/components/ui/Notice';
import type { Decision } from '@/lib/api/types';
import { reviewChanges } from './decision-format';

/**
 * "What changed", at the top of a card whose saved decision needs review
 * (spec 018 rule 5c, issue 222): when it was saved and each change in the
 * API's words (spec 007 rule 19d). Nothing here compares anything. Shown only
 * while a reason of kind `changed` is there; the salary question is asked on
 * its own (rule 5d).
 */
export function ReviewNotice({ decision }: { decision: Decision }) {
  const headingId = useId();
  const changes = reviewChanges(decision);
  if (!changes) return null;
  return (
    <Notice tone="warning" role="group" aria-labelledby={headingId}>
      <p className="m-0">
        <strong id={headingId}>What changed</strong>
      </p>
      <p className="mt-1 mb-0">{changes.since}</p>
      <ul className="my-1 pl-5">
        {changes.changes.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      <p className="m-0">
        The numbers here use what you have now. Check them and save again to update your plan.
      </p>
    </Notice>
  );
}
