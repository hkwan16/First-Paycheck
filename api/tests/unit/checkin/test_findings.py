"""checkin/findings.py: one pure finder per kind (spec 015 rules 1-7, finder examples)."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from pydantic import TypeAdapter

from checkin.findings import (
    FINDERS,
    BalanceFact,
    DeductionChangePayload,
    ElectionMismatchPayload,
    Finding,
    FindingPayload,
    GoalOffPacePayload,
    PayChangePayload,
    RecurringPayload,
    UpcomingDeadlinePayload,
    all_findings,
    deduction_change,
    election_mismatch,
    goal_off_pace,
    pay_change,
    recurring_changed,
    recurring_new,
    recurring_stopped,
    upcoming_deadline,
)
from db.enums import (
    CalendarKind,
    FindingKind,
    FindingSeverity,
    RecurringStatus,
    RecurringUserStatus,
)
from tests.unit.checkin.scenarios import (
    GOAL,
    GOAL_DECISION,
    HEALTH,
    HEALTH_DECISION,
    K401,
    K401_DECISION,
    PERIOD,
    S1,
    S2,
    S3,
    charge,
    event,
    facts,
    goal,
    stub,
)


def only(found: list[Finding]) -> Finding:
    assert len(found) == 1, found
    return found[0]


# ---------------------------------------------------------------- election mismatch


def test_election_not_applied() -> None:
    found = only(election_mismatch(facts(k401=K401, pay_stubs=[stub(S2)])))
    assert found.kind is FindingKind.ELECTION_MISMATCH
    assert found.severity is FindingSeverity.ALERT
    assert found.decision_id == K401_DECISION
    assert found.key == f"election_mismatch:k401_match:{K401_DECISION}:{S2['id']}"
    payload = found.payload
    assert isinstance(payload, ElectionMismatchPayload)
    assert payload.calculator == "k401_match"
    assert payload.affects == "k401_match"
    assert (payload.expected_cents, payload.actual_cents, payload.difference_cents) == (
        10_833,
        5_417,
        -5_416,
    )
    assert (payload.elected_pct, payload.actual_pct) == (Decimal("4.00"), Decimal("2.00"))
    assert str(payload.actual_pct) == "2.00"
    assert (payload.pay_stub_id, payload.pay_date) == (S2["id"], S2["pay_date"])
    assert payload.plan_name is None


def test_election_applied_within_a_cent() -> None:
    applied = stub(S2, retirement_contribution_cents=10_834)
    assert election_mismatch(facts(k401=K401, pay_stubs=[applied])) == []


def test_election_not_yet_due() -> None:
    assert election_mismatch(facts(k401=K401, pay_stubs=[stub(S1)])) == []


def test_health_premium_mismatch() -> None:
    found = only(
        election_mismatch(facts(health=HEALTH, pay_stubs=[stub(S2, medical_premium_cents=6_250)]))
    )
    assert found.severity is FindingSeverity.WARNING
    assert found.decision_id == HEALTH_DECISION
    assert found.key == f"election_mismatch:health_plans:{HEALTH_DECISION}:{S2['id']}"
    payload = found.payload
    assert isinstance(payload, ElectionMismatchPayload)
    assert (payload.calculator, payload.affects, payload.plan_name) == (
        "health_plans",
        "health_plans",
        "HDHP + HSA",
    )
    assert (payload.expected_cents, payload.actual_cents, payload.difference_cents) == (
        3_125,
        6_250,
        3_125,
    )
    assert (payload.elected_pct, payload.actual_pct) == (None, None)


def test_health_premium_matching_is_not_reported() -> None:
    assert election_mismatch(facts(health=HEALTH, pay_stubs=[stub(S2)])) == []


def test_no_stub_no_election_finding() -> None:
    assert election_mismatch(facts(k401=K401, health=HEALTH)) == []


# ---------------------------------------------------------------- goal off pace


def test_goal_off_pace() -> None:
    found = only(goal_off_pace(facts(goals=[goal()])))
    assert found.kind is FindingKind.GOAL_OFF_PACE
    assert found.severity is FindingSeverity.WARNING
    assert found.decision_id == GOAL_DECISION
    assert found.key == f"goal_off_pace:{GOAL}:{PERIOD}"
    payload = found.payload
    assert isinstance(payload, GoalOffPacePayload)
    assert payload.affects == "emergency_fund"
    assert payload.months_elapsed == 3
    assert (payload.start_balance_cents, payload.expected_cents) == (200_000, 290_000)
    assert (payload.balance_cents, payload.shortfall_cents) == (274_000, 16_000)
    assert payload.balance_as_of == dt.date(2026, 11, 15)
    assert payload.target_amount_cents == 547_000


def test_goal_on_pace() -> None:
    on_pace = goal(
        balances=[
            BalanceFact(as_of=dt.date(2026, 7, 31), balance_cents=200_000),
            BalanceFact(as_of=dt.date(2026, 11, 15), balance_cents=290_000),
        ]
    )
    assert goal_off_pace(facts(goals=[on_pace])) == []


def test_goal_at_target_is_not_behind() -> None:
    assert goal_off_pace(facts(goals=[goal(target_amount_cents=274_000)])) == []


def test_goal_start_is_the_oldest_balance_without_an_earlier_one() -> None:
    later_start = goal(started_on=dt.date(2026, 7, 1))
    found = only(goal_off_pace(facts(goals=[later_start])))
    assert isinstance(found.payload, GoalOffPacePayload)
    # Start 2026-07-01: no balance on or before it, so the oldest (200,000); 4 months to 11-15.
    assert (found.payload.months_elapsed, found.payload.expected_cents) == (4, 320_000)


def test_goal_without_balances_is_not_judged() -> None:
    assert goal_off_pace(facts(goals=[goal(balances=[])])) == []


def test_custom_goal_affects_nothing() -> None:
    from db.enums import GoalKind

    found = only(goal_off_pace(facts(goals=[goal(kind=GoalKind.CUSTOM)])))
    assert found.payload.affects is None


# ---------------------------------------------------------------- recurring


def test_recurring_new() -> None:
    equinox = charge("Equinox", RecurringStatus.NEW, 18_500)
    found = only(recurring_new(facts(recurring=[equinox])))
    assert found.kind is FindingKind.RECURRING_NEW
    assert found.severity is FindingSeverity.WARNING
    assert found.key == f"recurring_new:{equinox.id}:2026-11-03"
    assert found.decision_id is None
    payload = found.payload
    assert isinstance(payload, RecurringPayload)
    assert (payload.merchant, payload.typical_amount_cents, payload.affects) == (
        "Equinox",
        18_500,
        "spending",
    )
    assert (payload.first_seen, payload.last_seen) == (dt.date(2026, 9, 3), dt.date(2026, 11, 3))
    assert (payload.previous_amount_cents, payload.change_cents) == (None, None)


def test_recurring_price_rise() -> None:
    netflix = charge("Netflix", RecurringStatus.CHANGED, 1_699, last_reported_amount_cents=1_549)
    found = only(recurring_changed(facts(recurring=[netflix])))
    assert found.severity is FindingSeverity.WARNING
    assert isinstance(found.payload, RecurringPayload)
    assert (found.payload.previous_amount_cents, found.payload.change_cents) == (1_549, 150)


def test_recurring_price_drop() -> None:
    spotify = charge("Spotify", RecurringStatus.CHANGED, 999, last_reported_amount_cents=1_199)
    found = only(recurring_changed(facts(recurring=[spotify])))
    assert found.severity is FindingSeverity.INFO
    assert isinstance(found.payload, RecurringPayload)
    assert found.payload.change_cents == -200


def test_recurring_change_without_history() -> None:
    netflix = charge("Netflix", RecurringStatus.CHANGED, 1_699)
    found = only(recurring_changed(facts(recurring=[netflix])))
    assert found.severity is FindingSeverity.WARNING
    assert isinstance(found.payload, RecurringPayload)
    assert (found.payload.previous_amount_cents, found.payload.change_cents) == (None, None)


def test_recurring_stopped_after_cancel() -> None:
    hulu = charge(
        "Hulu",
        RecurringStatus.STOPPED,
        1_799,
        last_seen=dt.date(2026, 9, 3),
        first_seen=dt.date(2026, 6, 3),
        user_status=RecurringUserStatus.CANCELLED,
    )
    found = only(recurring_stopped(facts(recurring=[hulu])))
    assert found.severity is FindingSeverity.INFO
    assert found.key == f"recurring_stopped:{hulu.id}:2026-09-03"
    assert isinstance(found.payload, RecurringPayload)
    assert found.payload.user_status is RecurringUserStatus.CANCELLED


def test_ignored_charge_is_not_reported() -> None:
    ignored = charge(
        "Equinox", RecurringStatus.NEW, 18_500, user_status=RecurringUserStatus.IGNORED
    )
    assert all_findings(facts(recurring=[ignored])) == []


def test_each_recurring_finder_reports_only_its_status() -> None:
    charges = [
        charge("A", RecurringStatus.NEW, 100),
        charge("B", RecurringStatus.CHANGED, 100),
        charge("C", RecurringStatus.STOPPED, 100),
        charge("D", RecurringStatus.ACTIVE, 100),
    ]
    found = all_findings(facts(recurring=charges))
    assert [f.kind for f in found] == [
        FindingKind.RECURRING_NEW,
        FindingKind.RECURRING_CHANGED,
        FindingKind.RECURRING_STOPPED,
    ]


# ---------------------------------------------------------------- pay and deductions


def test_raise() -> None:
    newest = facts(pay_stubs=[stub(S3), stub(S1)])
    found = only(pay_change(newest))
    assert found.severity is FindingSeverity.INFO
    assert found.key == f"pay_change:{S3['id']}"
    payload = found.payload
    assert isinstance(payload, PayChangePayload)
    assert (payload.gross_change_cents, payload.net_change_cents) == (20_834, 19_241)
    assert (payload.previous_pay_stub_id, payload.previous_gross_cents) == (S1["id"], 270_833)
    assert payload.affects == "w4"
    assert deduction_change(newest) == []


def test_pay_cut() -> None:
    found = only(pay_change(facts(pay_stubs=[stub(S1), stub(S3)])))
    assert found.severity is FindingSeverity.WARNING
    assert isinstance(found.payload, PayChangePayload)
    assert (found.payload.gross_change_cents, found.payload.net_change_cents) == (-20_834, -19_241)


def test_pay_change_links_the_w4_decision() -> None:
    w4 = K401_DECISION
    found = only(pay_change(facts(pay_stubs=[stub(S3), stub(S1)], w4_decision_id=w4)))
    assert found.decision_id == w4


def test_deduction_changes() -> None:
    found = deduction_change(facts(pay_stubs=[stub(S2), stub(S1)]))
    assert [f.severity for f in found] == [FindingSeverity.INFO] * 3
    payloads = [f.payload for f in found]
    assert all(isinstance(p, DeductionChangePayload) for p in payloads)
    assert [
        (p.line, p.previous_cents, p.amount_cents, p.change_cents, p.affects)
        for p in payloads
        if isinstance(p, DeductionChangePayload)
    ] == [
        ("federal_withholding", 29_776, 21_196, -8_580, "w4"),
        ("retirement_contribution", 0, 5_417, 5_417, "k401_match"),
        ("medical_premium", 6_250, 3_125, -3_125, "health_plans"),
    ]
    assert [f.key for f in found] == [
        f"deduction_change:{S2['id']}:federal_withholding",
        f"deduction_change:{S2['id']}:retirement_contribution",
        f"deduction_change:{S2['id']}:medical_premium",
    ]
    assert pay_change(facts(pay_stubs=[stub(S2), stub(S1)])) == []


def test_deduction_changes_link_current_decisions() -> None:
    found = deduction_change(facts(pay_stubs=[stub(S2), stub(S1)], k401=K401, health=HEALTH))
    assert [f.decision_id for f in found] == [None, K401_DECISION, HEALTH_DECISION]


def test_one_stub_has_nothing_to_compare() -> None:
    one = facts(pay_stubs=[stub(S2)])
    assert pay_change(one) == []
    assert deduction_change(one) == []


# ---------------------------------------------------------------- upcoming deadlines


def test_upcoming_deadlines() -> None:
    soon = event(CalendarKind.GOAL_CONTRIBUTION, "2026-11-20")
    later = event(CalendarKind.ENROLLMENT_DEADLINE, "2026-12-16")
    found = upcoming_deadline(facts(events=[soon, later]))
    assert [(f.severity, f.key) for f in found] == [
        (FindingSeverity.WARNING, f"upcoming_deadline:{soon.id}"),
        (FindingSeverity.INFO, f"upcoming_deadline:{later.id}"),
    ]
    payloads = [f.payload for f in found]
    assert all(isinstance(p, UpcomingDeadlinePayload) for p in payloads)
    assert [
        (p.days_until, p.affects) for p in payloads if isinstance(p, UpcomingDeadlinePayload)
    ] == [
        (4, "emergency_fund"),
        (30, "health_plans"),
    ]


@pytest.mark.parametrize(
    ("kind", "affects"),
    [
        (CalendarKind.ELECTION_CHECK, "k401_match"),
        (CalendarKind.OPEN_ENROLLMENT, "health_plans"),
        (CalendarKind.GOAL_REVIEW, "emergency_fund"),
        (CalendarKind.GOAL_TARGET, "emergency_fund"),
        (CalendarKind.TAX_SEASON, "w4"),
    ],
)
def test_deadline_affects_by_kind(kind: CalendarKind, affects: str) -> None:
    found = only(upcoming_deadline(facts(events=[event(kind, "2026-11-30")])))
    assert found.payload.affects == affects


def test_seven_days_is_still_soon() -> None:
    found = only(upcoming_deadline(facts(events=[event(CalendarKind.TAX_SEASON, "2026-11-23")])))
    assert found.severity is FindingSeverity.WARNING


# ---------------------------------------------------------------- together


def test_nothing_to_report() -> None:
    assert all_findings(facts()) == []


def test_every_kind_has_a_finder() -> None:
    assert len(FINDERS) == len(FindingKind)


def test_all_findings_runs_in_rule_order() -> None:
    found = all_findings(
        facts(
            k401=K401,
            health=HEALTH,
            pay_stubs=[stub(S2), stub(S1)],
            goals=[goal()],
            recurring=[charge("Equinox", RecurringStatus.NEW, 18_500)],
            events=[event(CalendarKind.GOAL_CONTRIBUTION, "2026-11-20")],
        )
    )
    assert [f.kind for f in found] == [
        FindingKind.ELECTION_MISMATCH,
        FindingKind.GOAL_OFF_PACE,
        FindingKind.RECURRING_NEW,
        FindingKind.DEDUCTION_CHANGE,
        FindingKind.DEDUCTION_CHANGE,
        FindingKind.DEDUCTION_CHANGE,
        FindingKind.UPCOMING_DEADLINE,
    ]


def test_payloads_round_trip_through_json() -> None:
    found = all_findings(facts(k401=K401, pay_stubs=[stub(S2), stub(S1)], goals=[goal()]))
    adapter: TypeAdapter[FindingPayload] = TypeAdapter(FindingPayload)
    for finding in found:
        stored = finding.payload.model_dump(mode="json")
        assert stored["kind"] == finding.kind.value
        assert adapter.validate_python(stored) == finding.payload


def test_payload_kind_must_match_its_model() -> None:
    adapter: TypeAdapter[FindingPayload] = TypeAdapter(FindingPayload)
    with pytest.raises(ValueError, match="kind"):
        adapter.validate_python({"kind": "nope", "affects": None})
