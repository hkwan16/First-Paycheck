"""checkin/engine.py: reconciling a refresh with what a check-in holds (spec 015 rule 10)."""

from __future__ import annotations

import uuid

from checkin.engine import Existing, reconcile, subject_gone
from checkin.findings import Finding, all_findings
from db.enums import FindingKind, RecurringStatus
from tests.unit.checkin.scenarios import K401, S1, S2, charge, facts, goal, stub

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
    deduction = existing(candidate(FindingKind.DEDUCTION_CHANGE))
    changes = reconcile([new_charge, deduction], [], set())
    assert changes.retract == []


def test_reported_elsewhere_is_dropped() -> None:
    deduction = candidate(FindingKind.DEDUCTION_CHANGE)
    changes = reconcile([], [deduction], {deduction.key})
    assert changes.dropped == [deduction]
    assert changes.insert == []


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


def test_subject_gone_reads_the_recurring_charge_id() -> None:
    charge_id = uuid.uuid4()
    payload = {"recurring_charge_id": str(charge_id)}
    for kind in (
        FindingKind.RECURRING_NEW,
        FindingKind.RECURRING_CHANGED,
        FindingKind.RECURRING_STOPPED,
    ):
        assert subject_gone(kind, payload, {charge_id}) is False
        assert subject_gone(kind, payload, set()) is True
    # Findings about pay stubs, decisions and events never depend on bank data.
    assert subject_gone(FindingKind.PAY_CHANGE, {}, set()) is False
    assert subject_gone(FindingKind.GOAL_OFF_PACE, {"goal_id": str(charge_id)}, set()) is False
