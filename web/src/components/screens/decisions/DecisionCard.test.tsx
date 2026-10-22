import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GrowthIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { decisionSaveState } from '@/lib/decisions';
import { sampleDecision, sampleK401 } from '@/test/fixtures/decisions';
import { DecisionCard, PlaceholderCard, SaveButton } from './DecisionCard';

describe('DecisionCard', () => {
  it('is a region named by its heading, with the status badge beside it', () => {
    render(
      <DecisionCard
        id="k401"
        title="401(k) match"
        icon={<GrowthIcon />}
        tone="plum"
        badge={<Badge>Not saved</Badge>}
      >
        <p>Body</p>
      </DecisionCard>,
    );
    const card = screen.getByRole('region', { name: '401(k) match' });
    expect(
      within(card).getByRole('heading', { level: 2, name: '401(k) match' }),
    ).toBeInTheDocument();
    expect(within(card).getByText('Not saved')).toBeInTheDocument();
    expect(within(card).getByText('Body')).toBeInTheDocument();
  });
});

describe('PlaceholderCard', () => {
  it('marks a calculator that is off in this build as coming after the alpha', () => {
    render(<PlaceholderCard calculator="w4" />);
    const card = screen.getByRole('region', { name: 'W-4, federal only' });
    expect(within(card).getByText('After alpha')).toBeInTheDocument();
    expect(card).toHaveTextContent('This calculator arrives after the alpha.');
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says what each calculator will decide', () => {
    render(<PlaceholderCard calculator="health_plan" />);
    expect(screen.getByRole('region', { name: 'Health plan' })).toHaveTextContent(
      'Which plan costs less at the care you expect.',
    );
  });
});

describe('SaveButton', () => {
  const current = sampleDecision();

  it('saves only when the result is current, and is pressed once saved', () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <SaveButton state={decisionSaveState(undefined, null)} canSave={false} onSave={onSave} />,
    );
    expect(screen.getByRole('button', { name: 'Save this decision' })).toBeDisabled();

    rerender(
      <SaveButton
        state={decisionSaveState(current, sampleK401(6).inputs)}
        canSave
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save as v2' }));
    expect(onSave).toHaveBeenCalledTimes(1);

    rerender(
      <SaveButton
        state={decisionSaveState(current, current.inputs)}
        canSave={false}
        onSave={onSave}
      />,
    );
    expect(screen.getByRole('button', { name: 'Saved as v1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('is busy while saving', () => {
    render(
      <SaveButton state={decisionSaveState(undefined, null)} canSave saving onSave={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Save this decision' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });
});
