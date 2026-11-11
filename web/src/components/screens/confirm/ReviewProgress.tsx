import { Notice } from '@/components/ui/Notice';
import type { ReviewSaveState } from '@/lib/api/hooks';

/**
 * Whether the review's progress is kept with the document (spec 005 rule
 * 23e), beside the count of confirmed fields: "Saving your progress" while a
 * change is on its way, "Progress saved" once it is stored, nothing before
 * the first change. Not a live region: it changes with every confirm.
 */
export function SaveStatus({ state }: { state: ReviewSaveState }) {
  if (state === 'saving') return <span> · Saving your progress</span>;
  if (state === 'saved') return <span> · Progress saved</span>;
  return null;
}

/**
 * The last save of the review's progress failed: what is on screen is still
 * here and can be confirmed, but a reload would lose it. The next change
 * tries again.
 */
export function ProgressNotSaved({ state }: { state: ReviewSaveState }) {
  if (state !== 'failed') return null;
  return (
    <Notice tone="warning" compact role="status">
      Your progress on this page could not be saved, so a reload would lose it.
    </Notice>
  );
}
