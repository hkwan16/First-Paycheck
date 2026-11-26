import { Badge } from '@/components/ui/Badge';
import { Num } from '@/components/ui/Money';
import { reviewVerb, type SavedCount } from '@/lib/decisions';

export interface SavedCountBadgeProps {
  count: SavedCount;
}

/**
 * The step's "4 of 4 saved" chip (spec 018 rule 5), with ", 2 need review"
 * while any saved decision does (issue 257). It says what `savedCountText`
 * says, in the same order, with each count a `Num`: the saved count was one
 * before issue 257, so the chip renders as it did, and the review count
 * follows it. The total is the four calculators, plain text as before.
 */
export function SavedCountBadge({ count: { saved, total, needsReview } }: SavedCountBadgeProps) {
  return (
    <Badge>
      <Num value={saved} /> of {total} saved
      {needsReview > 0 && (
        <>
          , <Num value={needsReview} /> {reviewVerb(needsReview)} review
        </>
      )}
    </Badge>
  );
}
