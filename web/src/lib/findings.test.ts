import { describe, expect, it } from 'vitest';
import { completedNovemberCheckIn, NOVEMBER_ID, novemberCheckIn } from '@/test/fixtures/checkins';
import { findingsReducer, userActionOf } from './findings';

const AT = '2026-11-16T18:00:00Z';
const LATER = '2026-11-17T09:00:00Z';

describe('findingsReducer', () => {
  it('marks a finding done, stamps it and counts it handled', () => {
    const state = novemberCheckIn();
    const id = state.findings[0]!.id;
    const next = findingsReducer(state, { type: 'done', findingId: id, at: AT });
    expect(next.findings[0]).toMatchObject({ user_action: 'done', user_action_at: AT });
    expect(next.handled_count).toBe(1);
    expect(next.finding_count).toBe(9);
    expect(next.status).toBe('open');
    expect(next.completed_at).toBeNull();
    // Pure: the state passed in is untouched.
    expect(state.findings[0]!.user_action).toBeNull();
    expect(state.handled_count).toBe(0);
  });

  it('dismisses a finding', () => {
    const state = novemberCheckIn();
    const id = state.findings[2]!.id;
    const next = findingsReducer(state, { type: 'dismiss', findingId: id, at: AT });
    expect(next.findings[2]).toMatchObject({ user_action: 'dismissed', user_action_at: AT });
    expect(next.handled_count).toBe(1);
  });

  it('keeps the first stamp when the same action comes again (spec 015 rule 18)', () => {
    const once = findingsReducer(novemberCheckIn(), {
      type: 'done',
      findingId: novemberCheckIn().findings[0]!.id,
      at: AT,
    });
    const twice = findingsReducer(once, {
      type: 'done',
      findingId: once.findings[0]!.id,
      at: LATER,
    });
    expect(twice).toBe(once);
  });

  it('switches done to dismissed with the new time', () => {
    const state = completedNovemberCheckIn();
    const id = state.findings[0]!.id;
    const next = findingsReducer(state, { type: 'dismiss', findingId: id, at: LATER });
    expect(next.findings[0]).toMatchObject({ user_action: 'dismissed', user_action_at: LATER });
    expect(next.handled_count).toBe(9);
  });

  it('completes the check-in when the last finding is handled (rule 13)', () => {
    const done = completedNovemberCheckIn();
    const last = done.findings.at(-1)!;
    const open = findingsReducer(done, { type: 'undo', findingId: last.id, at: AT });
    expect(open.status).toBe('open');
    expect(open.completed_at).toBeNull();
    expect(open.handled_count).toBe(8);

    const closed = findingsReducer(open, { type: 'done', findingId: last.id, at: LATER });
    expect(closed.status).toBe('completed');
    expect(closed.completed_at).toBe(LATER);
    expect(closed.handled_count).toBe(9);
  });

  it('keeps completed_at while a completed check-in stays completed', () => {
    const state = completedNovemberCheckIn();
    const next = findingsReducer(state, {
      type: 'dismiss',
      findingId: state.findings[0]!.id,
      at: LATER,
    });
    expect(next.status).toBe('completed');
    expect(next.completed_at).toBe(state.completed_at);
  });

  it('undoes a finding: no action, no stamp', () => {
    const state = completedNovemberCheckIn();
    const next = findingsReducer(state, { type: 'undo', findingId: state.findings[1]!.id, at: AT });
    expect(next.findings[1]).toMatchObject({ user_action: null, user_action_at: null });
  });

  it('restores a finding as it was, for a rollback', () => {
    const state = completedNovemberCheckIn();
    const before = state.findings[4]!;
    const undone = findingsReducer(state, { type: 'undo', findingId: before.id, at: AT });
    const restored = findingsReducer(undone, {
      type: 'restore',
      findingId: before.id,
      userAction: before.user_action,
      at: before.user_action_at,
      completedAt: state.completed_at,
    });
    expect(restored).toEqual(state);
  });

  it('ignores a finding it does not have', () => {
    const state = novemberCheckIn();
    expect(findingsReducer(state, { type: 'done', findingId: 'nope', at: AT })).toBe(state);
  });

  it('never completes a check-in with no findings', () => {
    const empty = novemberCheckIn({ findings: [], finding_count: 0 });
    expect(empty.id).toBe(NOVEMBER_ID);
    expect(findingsReducer(empty, { type: 'done', findingId: 'nope', at: AT }).status).toBe('open');
  });
});

describe('userActionOf', () => {
  it('names the PATCH body for each action', () => {
    expect(userActionOf('done')).toBe('done');
    expect(userActionOf('dismiss')).toBe('dismissed');
    expect(userActionOf('undo')).toBeNull();
  });
});
