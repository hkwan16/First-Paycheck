import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GrowthIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { DecisionCard, PlaceholderCard } from './DecisionCard';

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
    render(<PlaceholderCard calculator="w4" live={false} />);
    const card = screen.getByRole('region', { name: 'W-4, federal only' });
    expect(within(card).getByText('After alpha')).toBeInTheDocument();
    expect(card).toHaveTextContent('This calculator arrives after the alpha.');
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });

  it('marks a live calculator whose card is not built yet as coming in a later milestone', () => {
    render(<PlaceholderCard calculator="emergency_fund" live />);
    const card = screen.getByRole('region', { name: 'Emergency fund' });
    expect(within(card).getByText('Coming later')).toBeInTheDocument();
    expect(card).toHaveTextContent('Coming in a later milestone.');
  });

  it('says what each calculator will decide', () => {
    render(<PlaceholderCard calculator="health_plan" live={false} />);
    expect(screen.getByRole('region', { name: 'Health plan' })).toHaveTextContent(
      'Which plan costs less at the care you expect.',
    );
  });
});
