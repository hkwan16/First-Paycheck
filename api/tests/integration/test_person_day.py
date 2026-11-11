"""The person's day through the routes and jobs (spec 019 examples 6-17, 21, 23, 24).

The Pacific person's browser reported ``America/Los_Angeles``; a person with no
zone reads as ``America/New_York`` (rule 1). Each test freezes the request clock
(``get_now``) and, for jobs, the worker's clock at an evening hour where the
Pacific date is still the day before the UTC date.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.db import user_session_for
from app.deps import get_now
from db.enums import CalendarKind, JobKind, PayFrequency
from jobs import queue
from tests.conftest import FixtureUser
from tests.support.checkin_jobs import checkin_jobs, findings, run_all
from tests.support.factories import (
    make_account,
    make_calendar_event,
    make_check_in,
    make_document,
    make_item,
    make_pay_stub,
    make_snapshot,
    make_time_zone,
)
from tests.support.plan_user import HEALTH_PLANS, K401_V1, save_decision

Client = Callable[[FixtureUser], TestClient]

PACIFIC = "America/Los_Angeles"
# 22:27 PST on November 9 (issue 232); 01:27 EST on November 10.
EVENING = dt.datetime(2026, 11, 10, 6, 27, tzinfo=dt.UTC)
# 21:00 PST on November 30; 00:00 EST on December 1.
MONTH_END_EVENING = dt.datetime(2026, 12, 1, 5, 0, tzinfo=dt.UTC)


@pytest.fixture
def clock(app: FastAPI, db_connection: Connection) -> list[dt.datetime]:
    """The request clock, set by the test; no committed jobs in the queue (rolled back)."""
    db_connection.execute(text("DELETE FROM jobs"))
    now = [EVENING]
    app.dependency_overrides[get_now] = lambda: now[0]
    return now


@pytest.fixture
def pacific(db_connection: Connection, user_a: FixtureUser) -> FixtureUser:
    make_time_zone(db_connection, user_a.id, PACIFIC)
    return user_a


def get(client: TestClient, route: str) -> Any:
    response = client.get(route)
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------- the profile (rows 6-8)


def test_put_time_zone_saves_the_browsers_zone(
    clock: list[dt.datetime], client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    response = client.put("/profile/time-zone", json={"time_zone": PACIFIC})
    assert response.status_code == 200, response.text
    saved = response.json()
    assert (saved["time_zone"], saved["today"]) == (PACIFIC, "2026-11-09")
    assert (saved["salary_cents"], saved["match_tiers"], saved["dependents"]) == (None, [], 0)
    assert get(client, "/profile") == saved

    # PUT /profile replaces the rest of the profile and leaves the zone alone.
    replaced = client.put("/profile", json={"salary_cents": 6_500_000})
    assert replaced.status_code == 200, replaced.text
    assert (replaced.json()["time_zone"], replaced.json()["salary_cents"]) == (PACIFIC, 6_500_000)
    # PUT /profile takes no zone of its own.
    refused = client.put("/profile", json={"time_zone": "UTC"})
    assert refused.status_code == 422

    moved = client.put("/profile/time-zone", json={"time_zone": "Asia/Kolkata"})
    assert moved.status_code == 200, moved.text
    # 06:27 UTC is 11:57 IST on November 10.
    assert (moved.json()["time_zone"], moved.json()["today"]) == ("Asia/Kolkata", "2026-11-10")
    assert moved.json()["salary_cents"] == 6_500_000


@pytest.mark.parametrize(
    "body",
    [
        {"time_zone": "Mars/Olympus"},
        {"time_zone": ""},
        {"time_zone": "America/New_York "},
        {"time_zone": "A" * 65},
        {"time_zone": None},
        {},
        {"time_zone": PACIFIC, "today": "2026-11-09"},
    ],
)
def test_put_time_zone_refuses_an_unknown_name(
    clock: list[dt.datetime], client_as: Client, user_a: FixtureUser, body: dict[str, Any]
) -> None:
    client = client_as(user_a)
    response = client.put("/profile/time-zone", json=body)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert get(client, "/profile")["time_zone"] is None


def test_an_unknown_name_says_what_to_send(
    clock: list[dt.datetime], client_as: Client, user_a: FixtureUser
) -> None:
    response = client_as(user_a).put("/profile/time-zone", json={"time_zone": "Mars/Olympus"})
    assert response.json()["error"]["message"] == (
        "Choose a time zone from the IANA list, such as America/Los_Angeles."
    )


def test_profile_today_defaults_to_eastern(
    clock: list[dt.datetime], client_as: Client, user_a: FixtureUser
) -> None:
    clock[0] = dt.datetime(2026, 11, 10, 3, 27, tzinfo=dt.UTC)
    profile = get(client_as(user_a), "/profile")
    assert (profile["time_zone"], profile["today"]) == (None, "2026-11-09")


# ---------------------------------------------------------------- the plan and calendar (9-12)


def test_plan_is_as_of_the_persons_day(
    clock: list[dt.datetime],
    client_as: Client,
    pacific: FixtureUser,
    user_b: FixtureUser,
    db_connection: Connection,
) -> None:
    for user in (pacific, user_b):
        make_calendar_event(
            db_connection,
            user.id,
            due_at=dt.date(2026, 11, 9),
            kind=CalendarKind.ENROLLMENT_DEADLINE,
            title="Health plan enrollment deadline",
        )
    plan = get(client_as(pacific), "/plan")
    assert (plan["as_of"], plan["calendar_through"]) == ("2026-11-09", "2027-02-07")
    assert [(e["due_at"], e["overdue"]) for e in plan["calendar"]] == [("2026-11-09", False)]

    eastern = get(client_as(user_b), "/plan")
    assert (eastern["as_of"], eastern["calendar_through"]) == ("2026-11-10", "2027-02-08")
    assert [(e["due_at"], e["overdue"]) for e in eastern["calendar"]] == [("2026-11-09", True)]


def test_calendar_overdue_on_the_persons_day(
    clock: list[dt.datetime],
    client_as: Client,
    pacific: FixtureUser,
    user_b: FixtureUser,
    db_connection: Connection,
) -> None:
    for user in (pacific, user_b):
        make_calendar_event(db_connection, user.id, due_at=dt.date(2026, 11, 9))
    assert [e["overdue"] for e in get(client_as(pacific), "/calendar")] == [False]
    assert [e["overdue"] for e in get(client_as(user_b), "/calendar")] == [True]


def _save_health_plan(client: TestClient, deadline: str) -> dict[str, Any]:
    inputs = {**HEALTH_PLANS, "enrollment_deadline": deadline}
    result = client.post("/calc/health-plans", json=inputs)
    assert result.status_code == 200, result.text
    saved = client.post(
        "/decisions",
        json={
            "calculator": "health_plans",
            "inputs": inputs,
            "result": result.json(),
            "supersedes_id": None,
        },
    )
    assert saved.status_code == 201, saved.text
    body: dict[str, Any] = saved.json()
    return body


def test_deadline_on_the_persons_today_makes_its_event(
    clock: list[dt.datetime], client_as: Client, pacific: FixtureUser, user_b: FixtureUser
) -> None:
    saved = _save_health_plan(client_as(pacific), "2026-11-09")
    assert saved["calendar_event_id"] is not None
    events = get(client_as(pacific), "/calendar")
    assert [(e["kind"], e["due_at"], e["overdue"]) for e in events] == [
        ("enrollment_deadline", "2026-11-09", False)
    ]
    # For the Eastern person November 9 has passed: no event.
    assert _save_health_plan(client_as(user_b), "2026-11-09")["calendar_event_id"] is None


def test_next_pay_date_after_the_persons_today(
    clock: list[dt.datetime],
    client_as: Client,
    pacific: FixtureUser,
    user_b: FixtureUser,
    db_connection: Connection,
) -> None:
    # 23:00 PST on November 14; 02:00 EST on November 15.
    clock[0] = dt.datetime(2026, 11, 15, 7, 0, tzinfo=dt.UTC)
    for user in (pacific, user_b):
        document = make_document(db_connection, user.id, with_blob=False)
        make_pay_stub(
            db_connection,
            user.id,
            document,
            pay_frequency=PayFrequency.SEMIMONTHLY,
            pay_date=dt.date(2026, 10, 31),
            period_start=dt.date(2026, 10, 16),
            period_end=dt.date(2026, 10, 31),
        )
        save_decision(client_as(user), "k401_match", K401_V1)
    due = {
        user.id: [e["due_at"] for e in get(client_as(user), "/calendar")]
        for user in (pacific, user_b)
    }
    assert due == {pacific.id: ["2026-11-15"], user_b.id: ["2026-11-30"]}


# ---------------------------------------------------------------- spending (13)


@pytest.mark.parametrize("route", ["/spending/summary", "/cashflow"])
def test_spending_default_is_the_persons_last_month(
    clock: list[dt.datetime], client_as: Client, pacific: FixtureUser, route: str
) -> None:
    clock[0] = MONTH_END_EVENING
    body = get(client_as(pacific), route)
    assert (body["start"], body["end"]) == ("2026-10-01", "2026-10-31")


# ---------------------------------------------------------------- check-ins (14-17)


def test_check_in_now_checks_in_the_persons_month(
    clock: list[dt.datetime], client_as: Client, pacific: FixtureUser, db_connection: Connection
) -> None:
    clock[0] = MONTH_END_EVENING
    response = client_as(pacific).post("/check-ins")
    assert response.status_code == 202, response.text
    [job] = checkin_jobs(db_connection)
    assert job["idempotency_key"] == "checkin.monthly:2026-11"
    assert job["payload"] == {"period": "2026-11-01", "trigger": "schedule"}


def test_past_is_the_persons_day(
    clock: list[dt.datetime], client_as: Client, pacific: FixtureUser, db_connection: Connection
) -> None:
    check_in = make_check_in(db_connection, pacific.id, as_of=dt.date(2026, 11, 30))
    clock[0] = MONTH_END_EVENING
    assert [c["past"] for c in get(client_as(pacific), "/check-ins")] == [False]
    assert get(client_as(pacific), f"/check-ins/{check_in}")["past"] is False
    # 00:00 PST on December 1.
    clock[0] = dt.datetime(2026, 12, 1, 8, 0, tzinfo=dt.UTC)
    assert [c["past"] for c in get(client_as(pacific), "/check-ins")] == [True]


def test_check_in_run_counts_from_the_persons_day(
    clock: list[dt.datetime], client_as: Client, pacific: FixtureUser, db_connection: Connection
) -> None:
    make_calendar_event(
        db_connection,
        pacific.id,
        due_at=dt.date(2026, 11, 15),
        kind=CalendarKind.W4_SUBMIT,
        title="Give your employer your updated Form W-4",
    )
    client = client_as(pacific)
    # 12:00 PST on November 9, then 22:27 PST the same day.
    for now in (dt.datetime(2026, 11, 9, 20, 0, tzinfo=dt.UTC), EVENING):
        clock[0] = now
        assert client.post("/check-ins").status_code == 202
        run_all(db_connection, now)
        [finding] = findings(db_connection, pacific)
        assert (finding["kind"], finding["payload"]["days_until"]) == ("upcoming_deadline", 6)
        [summary] = get(client, "/check-ins")
        assert summary["as_of"] == "2026-11-09"
        assert summary["last_run_at"] == now.isoformat().replace("+00:00", "Z")


def test_check_in_run_before_its_month_judges_its_first_day(
    clock: list[dt.datetime], client_as: Client, pacific: FixtureUser, db_connection: Connection
) -> None:
    with user_session_for(pacific.id, bind=db_connection) as session:
        queue.enqueue(
            session,
            user_id=pacific.id,
            kind=JobKind.CHECKIN_MONTHLY,
            payload={"period": "2026-11-01", "trigger": "schedule"},
        )
    # 22:00 PDT on October 31: the job was queued in another zone's November.
    now = dt.datetime(2026, 11, 1, 5, 0, tzinfo=dt.UTC)
    clock[0] = now
    run_all(db_connection, now)
    [summary] = get(client_as(pacific), "/check-ins")
    assert (summary["period"], summary["as_of"]) == ("2026-11-01", "2026-11-01")


def test_recurring_detect_uses_the_persons_day(
    clock: list[dt.datetime], pacific: FixtureUser, db_connection: Connection
) -> None:
    make_check_in(db_connection, pacific.id, period=dt.date(2026, 11, 1))
    with user_session_for(pacific.id, bind=db_connection) as session:
        queue.enqueue(session, user_id=pacific.id, kind=JobKind.RECURRING_DETECT)
    run_all(db_connection, MONTH_END_EVENING)
    refreshes = [job for job in checkin_jobs(db_connection) if job["payload"]["trigger"] == "sync"]
    assert [job["payload"]["period"] for job in refreshes] == ["2026-11-01"]


# ---------------------------------------------------------------- net worth (21)


def test_net_worth_dates_snapshots_on_the_persons_day(
    clock: list[dt.datetime],
    client_as: Client,
    pacific: FixtureUser,
    user_b: FixtureUser,
    db_connection: Connection,
) -> None:
    for user in (pacific, user_b):
        account = make_account(db_connection, user.id, make_item(db_connection, user.id))
        for balance, taken in (
            (100_000, dt.datetime(2026, 10, 31, 20, 0, tzinfo=dt.UTC)),
            (120_000, dt.datetime(2026, 11, 1, 5, 0, tzinfo=dt.UTC)),
        ):
            make_snapshot(db_connection, user.id, account, balance_cents=balance, as_of=taken)

    def series(user: FixtureUser) -> list[tuple[str, int]]:
        body = get(client_as(user), "/net-worth?months=2")
        return [(point["month"], point["net_worth_cents"]) for point in body["series"]]

    assert series(pacific) == [("2026-10-01", 120_000), ("2026-11-01", 120_000)]
    assert series(user_b) == [("2026-10-01", 100_000), ("2026-11-01", 120_000)]


# ---------------------------------------------------------------- the birth year (24)


def test_birth_year_bound_is_the_persons_year(
    clock: list[dt.datetime], client_as: Client, pacific: FixtureUser, user_b: FixtureUser
) -> None:
    # 21:00 PST on December 31, 2026; 00:00 EST on January 1, 2027.
    clock[0] = dt.datetime(2027, 1, 1, 5, 0, tzinfo=dt.UTC)
    refused = client_as(pacific).put("/profile", json={"birth_year": 2027})
    assert refused.status_code == 422
    assert refused.json()["error"]["message"] == "The birth year must be at most 2026"
    assert client_as(user_b).put("/profile", json={"birth_year": 2027}).status_code == 200
