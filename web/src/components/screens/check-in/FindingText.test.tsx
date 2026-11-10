import { describe, expect, it } from 'vitest';
import type { Finding, FindingPayload } from '@/lib/api/types';
import {
  deadlineFinding,
  electionFinding,
  equinoxFinding,
  goalFinding,
  healthElectionFinding,
  huluFinding,
  netflixFinding,
  overdueFinding,
  payChangeFinding,
  paycheckFinding,
  payCutFinding,
} from '@/test/fixtures/checkins';
import { render, screen, within } from '@/test/render';
import { FindingText } from './FindingText';

/** The title and body a finding renders; each call renders on its own. */
function show(finding: Finding, past = false) {
  const { unmount } = render(<FindingText finding={finding} titleId="t" past={past} />);
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
      title: 'Your pay stub puts 2% in your 401(k). You chose 4%.',
      body: 'Your Nov 15, 2026 pay stub put $54.17 in your 401(k). At the rate you chose it would be $108.33 a paycheck, a difference of -$54.16. Ask payroll to update it.',
    });
  });

  it('election_mismatch (401(k)) without rates still states the amounts', () => {
    const finding = withPayload(electionFinding(), {
      elected_pct: null,
      actual_pct: null,
    });
    expect(show(finding).title).toBe('Your pay stub’s 401(k) amount differs from what you chose.');
  });

  it('election_mismatch (health plan): the plan named, the premium against the stub', () => {
    expect(show(healthElectionFinding())).toEqual({
      title: 'Your health premium differs from the HDHP + HSA plan.',
      body: 'Your Nov 15, 2026 pay stub took $62.50 for health coverage. The plan you chose costs $31.25 a paycheck, a difference of +$31.25. Check your enrollment with HR.',
    });
    const unnamed = withPayload(healthElectionFinding(), { plan_name: null });
    expect(show(unnamed).title).toBe('Your health premium differs from the plan you chose.');
  });

  it('goal_off_pace: what was expected by now and what is there', () => {
    expect(show(goalFinding())).toEqual({
      title: 'Your emergency fund is $160.00 behind.',
      body: 'To be on track it would hold $2,900.00 by now, $2,000.00 on Aug 1, 2026 plus $300.00 a month for 3 months. It held $2,740.00 on Nov 15, 2026, toward your $5,470.00 goal.',
    });
    const other = withPayload(goalFinding(), { affects: null, months_elapsed: 1 });
    expect(show(other).title).toBe('Your savings goal is $160.00 behind.');
    expect(show(other).body).toContain('a month for 1 month.');
  });

  it('recurring_new: the merchant, amount and cadence, and when it was seen', () => {
    expect(show(equinoxFinding())).toEqual({
      title: 'Equinox looks like a monthly charge of $185.00.',
      body: 'First charged Sep 3, 2026, most recently Nov 3, 2026.',
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
    expect(show(unknown).body).toBe('We have no earlier price for it.');
  });

  it('recurring_stopped: the last charge, and a cancellation the person marked', () => {
    expect(show(huluFinding())).toEqual({
      title: 'Hulu has stopped charging.',
      body: 'Last charged $17.99 on Sep 9, 2026. That matches the cancellation you marked.',
    });
    const quiet = withPayload(huluFinding(), { user_status: null });
    expect(show(quiet).body).toBe('Last charged $17.99 on Sep 9, 2026.');
  });

  it('pay_change: take-home before and after, then each line that moved (issue 202)', () => {
    expect(show(paycheckFinding())).toEqual({
      title: 'Your Nov 15, 2026 paycheck changed.',
      body: 'Take-home pay went from $1,996.04 to $2,058.92 (+$62.88) since your Oct 31, 2026 pay stub.',
    });
    render(<FindingText finding={paycheckFinding()} titleId="t" />);
    const table = screen.getByRole('table', {
      name: 'Your Oct 31, 2026 and Nov 15, 2026 pay stubs',
    });
    const rows = within(table)
      .getAllByRole('row')
      .map((row) => Array.from(row.children, (cell) => cell.textContent));
    expect(rows).toEqual([
      ['Line', 'Oct 31', 'Nov 15', 'Change'],
      ['Gross pay', '$2,708.33', '$2,708.33', '$0.00'],
      ['Federal tax', '$297.76', '$211.96', '-$85.80'],
      ['401(k)', '$0.00', '$54.17', '+$54.17'],
      ['Health premiums', '$62.50', '$31.25', '-$31.25'],
    ]);
  });

  it('pay_change: a raise with no deduction line that moved, and a cut', () => {
    expect(show(payChangeFinding()).body).toBe(
      'Take-home pay went from $1,996.04 to $2,188.45 (+$192.41) since your Oct 31, 2026 pay stub.',
    );
    render(<FindingText finding={payChangeFinding()} titleId="raise" />);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('row', { name: /^Gross pay/ })).toHaveTextContent('+$208.34');
    expect(show(payCutFinding()).body).toContain('(-$192.41)');
  });

  it('upcoming_deadline: the event title and when it is due, with no count of days', () => {
    // Spec 015 rule 9b (issue 233): days_until counts from the run's date, so
    // "in 4 days" read on a later day was wrong; no count is printed.
    expect(show(deadlineFinding())).toEqual({
      title: 'Make your first emergency fund contribution',
      body: 'Due Nov 20, 2026.',
    });
    for (const days of [0, 1, 25]) {
      expect(show(withPayload(deadlineFinding(), { days_until: days })).body).toBe(
        'Due Nov 20, 2026.',
      );
    }
    expect(show(deadlineFinding(), true).body).toBe('Due Nov 20, 2026.');
  });

  it('overdue_deadline: the date passed and nothing marked it done (issue 233)', () => {
    const overdue = overdueFinding();
    expect(show(overdue)).toEqual({
      title: 'Give your employer your updated Form W-4',
      body: 'It was due Nov 6, 2026, and is not marked done. Mark it done once you have done it.',
    });
    expect(show(overdue, true).body).toBe('It was due Nov 6, 2026, and was not marked done.');
  });

  it('words a past check-in’s findings in the past (spec 015 rule 9b)', () => {
    expect(show(electionFinding(), true)).toEqual({
      title: 'Your pay stub put 2% in your 401(k). You had chosen 4%.',
      body: 'Your Nov 15, 2026 pay stub put $54.17 in your 401(k). At the rate you had chosen it would have been $108.33 a paycheck, a difference of -$54.16.',
    });
    expect(show(healthElectionFinding(), true)).toEqual({
      title: 'Your health premium differed from the HDHP + HSA plan.',
      body: 'Your Nov 15, 2026 pay stub took $62.50 for health coverage. The plan you had chosen cost $31.25 a paycheck, a difference of +$31.25.',
    });
    expect(show(goalFinding(), true)).toEqual({
      title: 'Your emergency fund was $160.00 behind.',
      body: 'To be on track it would have held $2,900.00 by then, $2,000.00 on Aug 1, 2026 plus $300.00 a month for 3 months. It held $2,740.00 on Nov 15, 2026, toward your $5,470.00 goal.',
    });
    expect(show(equinoxFinding(), true).title).toBe(
      'Equinox looked like a monthly charge of $185.00.',
    );
    expect(show(netflixFinding(), true)).toEqual({
      title: 'Netflix charged $16.99 a month.',
      body: 'It had been $15.49, a change of +$1.50.',
    });
    expect(show(huluFinding(), true)).toEqual({
      title: 'Hulu had stopped charging.',
      body: 'Last charged $17.99 on Sep 9, 2026. That matched the cancellation you marked.',
    });
    expect(show(paycheckFinding(), true).title).toBe('Your Nov 15, 2026 paycheck changed.');
  });

  it('says when Spending no longer lists a recurring charge (issue 233)', () => {
    const gone = { ...equinoxFinding(), charge_gone: true };
    render(<FindingText finding={gone} titleId="gone" past />);
    expect(
      screen.getByText('Spending no longer counts this as a recurring charge.'),
    ).toBeInTheDocument();
    render(<FindingText finding={equinoxFinding()} titleId="kept" />);
    expect(screen.getAllByText(/no longer counts this/)).toHaveLength(1);
  });
});
