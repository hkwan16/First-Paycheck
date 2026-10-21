"""checkin/engine.py: reconciling a refresh with what a check-in holds (spec 015 rule 10)."""

from __future__ import annotations

import uuid

from checkin.engine import Existing, reconcile
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
