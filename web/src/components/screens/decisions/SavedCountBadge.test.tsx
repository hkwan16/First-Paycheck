import { describe, expect, it } from 'vitest';
import { savedCountText } from '@/lib/decisions';
import { render, screen } from '@/test/render';
import { SavedCountBadge } from './SavedCountBadge';

describe('SavedCountBadge (spec 018 rule 5, issue 257)', () => {
  it('reads as savedCountText does, with the saved count in tabular numerals as before', () => {
    const count = { saved: 4, total: 4, needsReview: 0 };
    render(<SavedCountBadge count={count} />);
    const badge = screen.getByText(/of 4 saved/);
    expect(badge).toHaveTextContent(savedCountText(count));
    expect(badge).toHaveTextContent('4 of 4 saved');
    // The saved count is a `Num` (components/ui/Money): the chip's one number before issue 257.
    expect(badge.querySelectorAll('.tabular-nums')).toHaveLength(1);
    expect(badge.querySelector('.tabular-nums')).toHaveTextContent('4');
  });

  it.each([
    [{ saved: 4, total: 4, needsReview: 2 }, '4 of 4 saved, 2 need review'],
    [{ saved: 3, total: 4, needsReview: 1 }, '3 of 4 saved, 1 needs review'],
    [{ saved: 0, total: 4, needsReview: 0 }, '0 of 4 saved'],
  ])('says the same words as savedCountText for %j', (count, text) => {
    render(<SavedCountBadge count={count} />);
    const badge = screen.getByText(/of 4 saved/);
    expect(badge).toHaveTextContent(text);
    expect(badge).toHaveTextContent(savedCountText(count));
    expect(badge.querySelectorAll('.tabular-nums')).toHaveLength(count.needsReview > 0 ? 2 : 1);
  });
});
