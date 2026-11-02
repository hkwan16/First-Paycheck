"""checkin/engine.py: reconciling a refresh with what a check-in holds (spec 015 rule 10)."""

from __future__ import annotations

import uuid

from checkin.engine import Existing, Subjects, reconcile, subject_gone
from checkin.findings import Finding, all_findings
from db.enums import FindingKind, RecurringStatus
from tests.unit.checkin.scenarios import K401, S1, S2, S2A, charge, facts, goal, stub

CANDIDATES = all_findings(
    facts(
        k401=K401,
        pay_stubs=[stub(S2), stub(S1)],
        goals=[goal()],
        recurring=[charge("Equinox", RecurringStatus.NEW, 18_500)],
    )
)


def candidate(kind: FindingKind) -> Finding:
    return next(f for f in CANDIDATES if f.kind is kind)


def existing(finding: Finding, *, handled: bool = False) -> Existing:
    return Existing(id=uuid.uuid4(), key=finding.key, kind=finding.kind, handled=handled)


def test_new_candidates_are_inserted() -> None:
    changes = reconcile([], CANDIDATES, set())
    assert changes.insert == CANDIDATES
    assert (changes.update, changes.retract, changes.dropped) == ([], [], [])


def test_refresh_keeps_the_users_action() -> None:
    k401 = candidate(FindingKind.ELECTION_MISMATCH)
    done = existing(k401, handled=True)
    changes = reconcile([done], [k401], set())
    # The row is updated in place, so its user action is untouched.
    assert changes.update == [(done.id, k401)]
    assert (changes.insert, changes.retract) == ([], [])


def test_cleared_condition_is_retracted() -> None:
    pace = candidate(FindingKind.GOAL_OFF_PACE)
    open_one, dismissed = existing(pace), existing(pace, handled=True)
    changes = reconcile([open_one, dismissed], [], set())
    assert changes.retract == [open_one.id]


def test_reported_events_are_kept() -> None:
    new_charge = existing(candidate(FindingKind.RECURRING_NEW))
    paycheck = existing(candidate(FindingKind.PAY_CHANGE))
    changes = reconcile([new_charge, paycheck], [], set())
    assert changes.retract == []


def test_reported_elsewhere_is_dropped() -> None:
    paycheck = candidate(FindingKind.PAY_CHANGE)
    changes = reconcile([], [paycheck], {paycheck.key})
    assert changes.dropped == [paycheck]
    assert changes.insert == []


def test_paycheck_change_about_a_superseded_stub_is_retracted_unless_handled() -> None:
    """Spec 015 rule 10.4: a corrected stub took the place of the one compared."""
    paycheck = candidate(FindingKind.PAY_CHANGE)
    gone = Existing(
        id=uuid.uuid4(), key=paycheck.key, kind=paycheck.kind, handled=False, subject_gone=True
    )
    kept = Existing(
        id=uuid.uuid4(), key="pay_change:x", kind=paycheck.kind, handled=True, subject_gone=True
    )
    changes = reconcile([gone, kept], [], set())
    assert changes.retract == [gone.id]


def test_newer_copy_updates_the_paycheck_change() -> None:
    """Spec 015 rule 12, issue 194: a copy of S2 is the same paycheck, so the same key."""
    first = all_findings(facts(pay_stubs=[stub(S2, paycheck_id=S2A), stub(S1)]))
    copy = all_findings(facts(pay_stubs=[stub(S2, id=uuid.uuid4(), paycheck_id=S2A), stub(S1)]))
    done = existing(first[0], handled=True)
    changes = reconcile([done], copy, set())
    assert changes.update == [(done.id, copy[0])]
    assert (changes.insert, changes.retract) == ([], [])


def test_event_whose_subject_is_gone_is_retracted_unless_handled() -> None:
    """Spec 015 rule 10.4, spec 017 rule 14: the charge went with an unlinked bank."""
    new_charge = candidate(FindingKind.RECURRING_NEW)
    gone = Existing(
        id=uuid.uuid4(), key=new_charge.key, kind=new_charge.kind, handled=False, subject_gone=True
    )
    kept = Existing(
        id=uuid.uuid4(), key="recurring_new:x", kind=gone.kind, handled=True, subject_gone=True
    )
    changes = reconcile([gone, kept], [], set())
    assert changes.retract == [gone.id]


NOTHING = Subjects(charge_ids=frozenset(), current_stub_ids=frozenset())


def test_subject_gone_reads_the_recurring_charge_id() -> None:
    charge_id = uuid.uuid4()
    payload = {"recurring_charge_id": str(charge_id)}
    for kind in (
        FindingKind.RECURRING_NEW,
        FindingKind.RECURRING_CHANGED,
        FindingKind.RECURRING_STOPPED,
    ):
        assert subject_gone(kind, payload, Subjects({charge_id}, frozenset())) is False
        assert subject_gone(kind, payload, NOTHING) is True
    # Findings about decisions, goals and events have no subject to lose.
    for kind in (FindingKind.ELECTION_MISMATCH, FindingKind.GOAL_OFF_PACE):
        assert subject_gone(kind, {"goal_id": str(charge_id)}, NOTHING) is False


def test_subject_gone_reads_both_stubs_of_a_paycheck_change() -> None:
    """Spec 015 rule 10.4: either stub superseded and the change it reported is gone."""
    newest, previous = uuid.uuid4(), uuid.uuid4()
    payload = {"pay_stub_id": str(newest), "previous_pay_stub_id": str(previous)}
    kind = FindingKind.PAY_CHANGE
    assert subject_gone(kind, payload, Subjects(frozenset(), {newest, previous})) is False
    assert subject_gone(kind, payload, Subjects(frozenset(), {newest})) is True
    assert subject_gone(kind, payload, Subjects(frozenset(), {previous})) is True
