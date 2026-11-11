"""A month's check-in as the person lives through it (spec 015 rules 7, 9b, 10, 12,
19 and 24; issues 233, 234 and 235).

The October user saves their four decisions through the API on 2026-10-21, so
the calendar dates come from the real side effects: the 401(k) election
check, the W-4 hand-in and the first emergency fund contribution, each due the
next payday (2026-10-31), the fund's review (2027-01-31) and the health plan's
enrollment deadline (2026-11-25). They press Check in now on 2026-10-28 and
again on 2026-11-01, then come back on 2026-11-09 without having marked
anything done.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.db import user_session_for
from app.deps import get_now
from db.enums import AccountKind, AccountRole, RecurringStatus
from sync.recurring import run_detection
from tests.conftest import FixtureUser
from tests.support.checkin_jobs import job_row, run_all
from tests.support.factories import (
    make_account,
    make_document,
    make_item,
    make_pay_stub,
    make_recurring_charge,
    make_snapshot,
)
from tests.support.plan_user import (
    EMERGENCY_FUND,
    HEALTH_PLANS,
    K401_V1,
    K401_V2,
    SALARY_CENTS,
    W4,
    save_decision,
)

Client = Callable[[FixtureUser], TestClient]

SAVED_AT = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)
OCTOBER_RUN = dt.datetime(2026, 10, 28, 12, 0, tzinfo=dt.UTC)
NOVEMBER_RUN = dt.datetime(2026, 11, 1, 12, 0, tzinfo=dt.UTC)
NOV_9 = dt.datetime(2026, 11, 9, 18, 0, tzinfo=dt.UTC)
PAYDAY = "2026-10-31"
ENROLLMENT = "2026-11-25"


class Clock:
    """The request clock (``get_now``) and the worker's, moved by the test."""

    def __init__(self) -> None:
        self.now = SAVED_AT

    def __call__(self) -> dt.datetime:
        return self.now


@pytest.fixture
def clock(app: FastAPI, db_connection: Connection) -> Clock:
    db_connection.execute(text("DELETE FROM jobs"))
    moved = Clock()
    app.dependency_overrides[get_now] = moved
    return moved


@dataclass(frozen=True)
class October:
    k401: uuid.UUID
    client: TestClient


def check_in_now(connection: Connection, client: TestClient, clock: Clock) -> dict[str, Any]:
    """Press Check in now at the clock's time and let the worker run the job."""
    response = client.post("/check-ins")
    assert response.status_code == 202, response.text
    run_all(connection, now=clock.now)
    job = job_row(connection, uuid.UUID(response.json()["job_id"]))
    assert job["status"] == "succeeded", job["last_error"]
    result: dict[str, Any] = job["result"]
    return result


def october_user(connection: Connection, client: TestClient, user: FixtureUser) -> uuid.UUID:
    """The stub, accounts and four decisions of the October user; returns the 401(k)."""
    profile = client.put(
        "/profile",
        json={"salary_cents": SALARY_CENTS, "pay_frequency": "semimonthly"},
    )
    assert profile.status_code == 200, profile.text
    make_pay_stub(connection, user.id, make_document(connection, user.id, with_blob=False))
    item = make_item(connection, user.id)
    savings = make_account(
        connection,
        user.id,
        item,
        kind=AccountKind.SAVINGS,
        role=AccountRole.EMERGENCY_FUND,
        name="Chase Savings",
        mask="7730",
    )
    make_snapshot(connection, user.id, savings, balance_cents=214_000)
    save_decision(client, "emergency_fund", EMERGENCY_FUND)
    k401 = save_decision(client, "k401_match", K401_V2)
    save_decision(client, "health_plans", {**HEALTH_PLANS, "enrollment_deadline": ENROLLMENT})
    save_decision(client, "w4", W4)
    return k401


@pytest.fixture
def october(
    clock: Clock, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> October:
    client = client_as(user_a)
    k401 = october_user(db_connection, client, user_a)
    clock.now = OCTOBER_RUN
    check_in_now(db_connection, client, clock)
    clock.now = NOVEMBER_RUN
    check_in_now(db_connection, client, clock)
    clock.now = NOV_9
    return October(k401=k401, client=client)


def check_in_of(client: TestClient, period: str) -> dict[str, Any]:
    listed = client.get("/check-ins")
    assert listed.status_code == 200, listed.text
    (summary,) = [row for row in listed.json() if row["period"] == period]
    response = client.get(f"/check-ins/{summary['id']}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def deadlines(check_in: dict[str, Any]) -> list[tuple[str, str, str, int]]:
    return sorted(
        (
            finding["kind"],
            finding["payload"]["calendar_kind"],
            finding["payload"]["due_at"],
            finding["payload"]["days_until"],
        )
        for finding in check_in["findings"]
        if finding["kind"] in ("upcoming_deadline", "overdue_deadline")
    )


# ---------------------------------------------------------------- issue 233


def test_a_past_check_in_is_a_record_of_its_date(october: October) -> None:
    """The October check-in opened on November 9 says when it was judged, and
    that its month is over; its findings are what that run found."""
    record = check_in_of(october.client, "2026-10-01")

    assert record["past"] is True
    assert record["as_of"] == "2026-10-28"
    # What the run on October 28 found, counted from that day: the record.
    assert deadlines(record) == [
        ("upcoming_deadline", "election_check", PAYDAY, 3),
        ("upcoming_deadline", "enrollment_deadline", ENROLLMENT, 28),
        ("upcoming_deadline", "goal_contribution", PAYDAY, 3),
        ("upcoming_deadline", "w4_submit", PAYDAY, 3),
    ]
    # The whole month, now that it is over.
    flow = record["cash_flow"]["cash_flow"]
    assert (flow["start"], flow["end"]) == ("2026-10-01", "2026-10-31")

    current = check_in_of(october.client, "2026-11-01")
    assert current["past"] is False
    assert current["as_of"] == "2026-11-01"


def test_an_overdue_date_is_a_finding_in_this_months_check_in(october: October) -> None:
    """Rule 7: the three paydays October reported as coming up passed on
    October 31 with nothing marked done. November reported none of them
    (rule 10.1), so before issue 233 the person was never told they were late."""
    november = check_in_of(october.client, "2026-11-01")

    assert deadlines(november) == [
        ("overdue_deadline", "election_check", PAYDAY, -1),
        ("overdue_deadline", "goal_contribution", PAYDAY, -1),
        ("overdue_deadline", "w4_submit", PAYDAY, -1),
    ]
    overdue = [f for f in november["findings"] if f["kind"] == "overdue_deadline"]
    assert {f["severity"] for f in overdue} == {"alert"}


def test_the_plan_and_coming_up_mark_an_overdue_date(october: October) -> None:
    """The plan's Next 90 days left the paydays out once they passed, and
    Coming up listed them without saying they were late."""
    plan = october.client.get("/plan")
    assert plan.status_code == 200, plan.text
    assert [(e["due_at"], e["kind"], e["overdue"]) for e in plan.json()["calendar"]] == [
        (PAYDAY, "election_check", True),
        (PAYDAY, "goal_contribution", True),
        (PAYDAY, "w4_submit", True),
        (ENROLLMENT, "enrollment_deadline", False),
        ("2027-01-31", "goal_review", False),
    ]

    # Spec 015 rule 22 orders by due date, then by when each was saved; the
    # test saves all four in one transaction, so a day's events tie on that.
    coming_up = october.client.get("/calendar", params={"to": "2026-12-31"})
    assert coming_up.status_code == 200, coming_up.text
    events = [(e["due_at"], e["kind"], e["overdue"]) for e in coming_up.json()]
    assert [due for due, _, _ in events] == [PAYDAY] * 3 + [ENROLLMENT]
    assert sorted(events) == [
        (PAYDAY, "election_check", True),
        (PAYDAY, "goal_contribution", True),
        (PAYDAY, "w4_submit", True),
        (ENROLLMENT, "enrollment_deadline", False),
    ]


def test_a_date_marked_done_is_settled(
    october: October, clock: Clock, db_connection: Connection
) -> None:
    """Rule 24: marking the W-4 reminder done on the October record settles the
    date: the plan and Coming up leave it out, and the next run takes back the
    overdue finding November had for it."""
    client = october.client
    record = check_in_of(client, "2026-10-01")
    (w4,) = [
        f
        for f in record["findings"]
        if f["kind"] == "upcoming_deadline" and f["payload"]["calendar_kind"] == "w4_submit"
    ]
    done = client.patch(
        f"/check-ins/{record['id']}/findings/{w4['id']}", json={"user_action": "done"}
    )
    assert done.status_code == 200, done.text

    kinds = [e["kind"] for e in client.get("/plan").json()["calendar"]]
    assert kinds == ["election_check", "goal_contribution", "enrollment_deadline", "goal_review"]
    coming_up = client.get("/calendar", params={"to": "2026-12-31"}).json()
    assert "w4_submit" not in [e["kind"] for e in coming_up]

    result = check_in_now(db_connection, client, clock)

    assert (result["inserted"], result["retracted"]) == (0, 1)
    assert [(k, c) for k, c, _, _ in deadlines(check_in_of(client, "2026-11-01"))] == [
        ("overdue_deadline", "election_check"),
        ("overdue_deadline", "goal_contribution"),
    ]

    # Undo puts the date back.
    undone = client.patch(
        f"/check-ins/{record['id']}/findings/{w4['id']}", json={"user_action": None}
    )
    assert undone.status_code == 200, undone.text
    assert "w4_submit" in [e["kind"] for e in client.get("/plan").json()["calendar"]]


def test_a_charge_spending_dropped_is_marked_on_the_record(
    clock: Clock, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Issue 233 (after issue 200): the October record still says loan interest
    looked like a monthly charge after the detector stopped counting it; the
    record keeps the finding and says Spending no longer lists the charge."""
    client = client_as(user_a)
    make_recurring_charge(
        db_connection,
        user_a.id,
        merchant_norm="interest",
        merchant_clean="Interest",
        typical_amount_cents=11_147,
        first_seen=dt.date(2026, 8, 28),
        last_seen=dt.date(2026, 10, 28),
        status=RecurringStatus.NEW,
    )
    clock.now = OCTOBER_RUN
    check_in_now(db_connection, client, clock)
    # The detector, reading cash accounts only (spec 009 rule 1a), finds no
    # charge for it and deletes the row (rule 15).
    with user_session_for(user_a.id, bind=db_connection) as session:
        run_detection(session, user_a.id, dt.date(2026, 11, 9))
    clock.now = NOV_9

    record = check_in_of(client, "2026-10-01")

    (finding,) = record["findings"]
    assert finding["kind"] == "recurring_new"
    assert finding["charge_gone"] is True


# ---------------------------------------------------------------- cash flow (rule 19)


def plan_lines(check_in: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {line["key"]: line for line in check_in["cash_flow"]["plan"]}


def test_deposits_are_not_called_take_home(october: October) -> None:
    """Issue 235: the line is the bank deposits Spending calls "Income deposited";
    take-home pay is the pay stub's figure."""
    lines = plan_lines(check_in_of(october.client, "2026-10-01"))

    assert "take_home" not in lines
    assert lines["income"]["label"] == "Income deposited"


def test_a_month_without_a_pay_stub_has_no_pay_stub_plan_yet(october: October) -> None:
    """November has no pay stub yet: the 401(k) and health lines said "plan
    $0.00, On plan" against a saved 4% election and a chosen plan."""
    lines = plan_lines(check_in_of(october.client, "2026-11-01"))

    for key in ("retirement", "health"):
        assert lines[key]["actual_cents"] == 0
        assert (lines[key]["plan_cents"], lines[key]["status"]) == (None, None)
        assert lines[key]["needs_pay_stub"] is True
    # October had the October 15 stub, so its plan stands.
    october_lines = plan_lines(check_in_of(october.client, "2026-10-01"))
    assert october_lines["retirement"]["plan_cents"] == 10_833
    assert october_lines["retirement"]["needs_pay_stub"] is False
    assert lines["essentials"]["needs_pay_stub"] is False


# ---------------------------------------------------------------- issue 234


def test_a_new_version_keeps_its_reminder(
    clock: Clock, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """A new 401(k) version replaces the election check with one due the same
    payday. Check in now said "1 new finding. 1 finding no longer applies."
    while the cards read the same; it is the same reminder, moved to the new
    version (rule 12)."""
    client = client_as(user_a)
    clock.now = dt.datetime(2026, 11, 2, 15, 0, tzinfo=dt.UTC)
    make_pay_stub(db_connection, user_a.id, make_document(db_connection, user_a.id))
    v1 = save_decision(client, "k401_match", K401_V1)
    first = check_in_now(db_connection, client, clock)
    assert first["inserted"] == 1

    clock.now = dt.datetime(2026, 11, 3, 15, 0, tzinfo=dt.UTC)
    v2 = save_decision(client, "k401_match", K401_V2, supersedes_id=v1)
    again = check_in_now(db_connection, client, clock)

    assert (again["inserted"], again["retracted"], again["updated"]) == (0, 0, 1)
    (reminder,) = check_in_of(client, "2026-11-01")["findings"]
    assert reminder["payload"]["due_at"] == "2026-11-15"
    assert reminder["decision_id"] == str(v2)
