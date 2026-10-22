import { describe, expect, it } from 'vitest';
import type { Finding, FindingPayload } from '@/lib/api/types';
import {
  deadlineFinding,
  deductionFindings,
  electionFinding,
  equinoxFinding,
  goalFinding,
  healthElectionFinding,
  huluFinding,
  netflixFinding,
  payChangeFinding,
  payCutFinding,
} from '@/test/fixtures/checkins';
import { render, screen } from '@/test/render';
import { FindingText } from './FindingText';

/** The title and body a finding renders; each call renders on its own. */
function show(finding: Finding) {
  const { unmount } = render(<FindingText finding={finding} titleId="t" />);
  const title = document.getElementById('t')!;
  const text = { title: title.textContent, body: title.nextElementSibling?.textContent };
  unmount();
  return text;
}

/** The finding with some payload fields changed (the API's shapes allow null where tested). */
function withPayload(finding: Finding, changes: Record<string, unknown>): Finding {
  return { ...finding, payload: { ...finding.payload, ...changes } as FindingPayload };
}

describe('FindingText', () => {
  it('election_mismatch (401(k)): the elected and withheld rates and amounts', () => {
    expect(show(electionFinding())).toEqual({
      title: 'Your 401(k) contribution is 2%, not the 4% you chose.',
      body: 'Your Nov 15, 2026 pay stub withheld $54.17. Your election works out to $108.33 a paycheck: a difference of -$54.16.',
    });
  });

  it('election_mismatch (401(k)) without rates still states the amounts', () => {
    const finding = withPayload(electionFinding(), {
      elected_pct: null,
      actual_pct: null,
    });
    expect(show(finding).title).toBe('Your 401(k) contribution does not match your election.');
  });

  it('election_mismatch (health plan): the plan named, the premium against the stub', () => {
    expect(show(healthElectionFinding())).toEqual({
      title: 'Your health premium does not match the HDHP + HSA plan.',
      body: 'Your Nov 15, 2026 pay stub took $62.50 for medical coverage. The plan you chose costs $31.25 a paycheck: a difference of +$31.25.',
    });
    const unnamed = withPayload(healthElectionFinding(), { plan_name: null });
    expect(show(unnamed).title).toBe('Your health premium does not match the plan you chose.');
  });

  it('goal_off_pace: what was expected by now and what is there', () => {
    expect(show(goalFinding())).toEqual({
      title: 'Your emergency fund is $160.00 behind pace.',
      body: 'On pace it would hold $2,900.00 by now: $2,000.00 on Aug 1, 2026 plus $300.00 a month for 3 months. It held $2,740.00 on Nov 15, 2026, toward a $5,470.00 target.',
    });
    const other = withPayload(goalFinding(), { affects: null, months_elapsed: 1 });
    expect(show(other).title).toBe('Your savings goal is $160.00 behind pace.');
    expect(show(other).body).toContain('a month for 1 month.');
  });

  it('recurring_new: the merchant, amount and cadence, and when it was seen', () => {
    expect(show(equinoxFinding())).toEqual({
      title: 'Equinox, $185.00, looks monthly.',
      body: 'First seen Sep 3, 2026, last charged Nov 3, 2026.',
    });
  });

  it('recurring_changed: the new price and the change from the last reported one', () => {
    expect(show(netflixFinding())).toEqual({
      title: 'Netflix now charges $16.99 a month.',
      body: 'It was $15.49, a change of +$1.50.',
    });
    const unknown = withPayload(netflixFinding(), {
      previous_amount_cents: null,
      change_cents: null,
    });
    expect(show(unknown).body).toBe('The earlier price is not on record.');
  });

  it('recurring_stopped: the last charge, and a cancellation the person marked', () => {
    expect(show(huluFinding())).toEqual({
      title: 'Hulu has stopped charging.',
      body: 'Last charged $17.99 on Sep 9, 2026. That matches the cancellation you marked.',
    });
    const quiet = withPayload(huluFinding(), { user_status: null });
    expect(show(quiet).body).toBe('Last charged $17.99 on Sep 9, 2026.');
  });

  it('pay_change: gross and take-home, before and after, with the API signs', () => {
    expect(show(payChangeFinding())).toEqual({
      title: 'Your gross pay changed by +$208.34 a paycheck.',
      body: '$2,916.67 on Nov 15, 2026, from $2,708.33 on Oct 31, 2026. Take-home went from $1,996.04 to $2,188.45 (+$192.41).',
    });
    expect(show(payCutFinding()).title).toBe('Your gross pay changed by -$208.34 a paycheck.');
  });

  it('deduction_change: the line, before and after, between the two stubs', () => {
    const [federal] = deductionFindings();
    expect(show(federal!)).toEqual({
      title: 'Federal tax went from $297.76 to $211.96.',
      body: 'A change of -$85.80 between the Oct 31, 2026 and Nov 15, 2026 pay stubs.',
    });
  });

  it('upcoming_deadline: the event title and when it is due', () => {
    expect(show(deadlineFinding())).toEqual({
      title: 'Make your first emergency fund contribution',
      body: 'Due Nov 20, 2026, in 4 days.',
    });
    const tomorrow = withPayload(deadlineFinding(), { days_until: 1 });
    expect(show(tomorrow).body).toBe('Due Nov 20, 2026, tomorrow.');
  });

  it('upcoming_deadline due today', () => {
    const today = withPayload(deadlineFinding(), { days_until: 0 });
    render(<FindingText finding={today} titleId="today" />);
    expect(screen.getByText('Due Nov 20, 2026, today.')).toBeInTheDocument();
  });
});
