"""POST /check-ins: check in now (spec 015 rule 23, route rows 8-10)."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.deps import get_now
from db.enums import CheckinStatus
from jobs import scheduler
from tests.conftest import FixtureUser
from tests.support.checkin_jobs import check_ins, checkin_jobs, findings, job_row, run_all
from tests.support.factories import make_check_in, make_snapshot
from tests.support.november import NOW, PERIOD, november

Client = Callable[[FixtureUser], TestClient]
KEY = "checkin.monthly:2026-11"
PAYLOAD = {"period": "2026-11-01", "trigger": "schedule"}


@pytest.fixture
def frozen(app: FastAPI, db_connection: Connection) -> FastAPI:
    db_connection.execute(text("DELETE FROM jobs"))
    app.dependency_overrides[get_now] = lambda: NOW
    return app


def check_in_now(client: TestClient) -> dict[str, Any]:
    response = client.post("/check-ins")
    assert response.status_code == 202, response.text
    body: dict[str, Any] = response.json()
    assert set(body) == {"job_id", "check_in_id"}
    return body


def test_check_in_now_queues_the_months_job(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    november(db_connection, user_a)
    client = client_as(user_a)

    first = check_in_now(client)
    again = check_in_now(client)

    assert first["check_in_id"] is None
    assert again == first
    queued = checkin_jobs(db_connection)
    assert [(j["idempotency_key"], j["payload"], j["status"]) for j in queued] == [
        (KEY, PAYLOAD, "queued")
    ]
    # The month's job exists, so the tick has nothing to queue for this user.
    assert scheduler.tick(bind=db_connection, now=NOW)["checkins_queued"] == 0

    run_all(db_connection)

    job = job_row(db_connection, first["job_id"])
    assert job["status"] == "succeeded", job["last_error"]
    made = check_ins(db_connection, user_a)
    assert [(c["period"], c["triggered_by"], c["status"]) for c in made] == [
        (PERIOD, "schedule", "open")
    ]
    assert job["result"]["outcome"] == "created"
    assert job["result"]["check_in_id"] == str(made[0]["id"])
    assert sorted(f["kind"] for f in findings(db_connection, user_a)) == [
        "deduction_change",
        "deduction_change",
        "deduction_change",
        "election_mismatch",
        "goal_off_pace",
        "recurring_new",
    ]


def test_check_in_now_refreshes_the_open_check_in(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    seeded = november(db_connection, user_a)
    client = client_as(user_a)
    keyed = check_in_now(client)["job_id"]
    run_all(db_connection)
    check_in = str(check_ins(db_connection, user_a)[0]["id"])
    # The goal catches up: 290,000 on 2026-11-16 is on pace.
    make_snapshot(
        db_connection,
        user_a.id,
        seeded.savings,
        balance_cents=290_000,
        as_of=dt.datetime(2026, 11, 16, 6, tzinfo=dt.UTC),
    )

    refresh = check_in_now(client)
    again = check_in_now(client)

    assert refresh["job_id"] != keyed
    assert refresh["check_in_id"] == check_in
    assert again == refresh
    queued = [j for j in checkin_jobs(db_connection) if j["status"] == "queued"]
    assert [(j["idempotency_key"], j["payload"]) for j in queued] == [(None, PAYLOAD)]

    run_all(db_connection)

    result = job_row(db_connection, refresh["job_id"])["result"]
    assert (result["outcome"], result["check_in_id"]) == ("refreshed", check_in)
    assert result["retracted"] == 1
    assert "goal_off_pace" not in {f["kind"] for f in findings(db_connection, user_a)}
    assert len(check_ins(db_connection, user_a)) == 1


def test_check_in_now_leaves_a_completed_check_in(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    november(db_connection, user_a)
    completed = make_check_in(
        db_connection, user_a.id, status=CheckinStatus.COMPLETED, completed_at=NOW
    )

    body = check_in_now(client_as(user_a))
    run_all(db_connection)

    assert body["check_in_id"] == str(completed)
    assert job_row(db_connection, body["job_id"])["result"]["outcome"] == "skipped"
    assert [c["status"] for c in check_ins(db_connection, user_a)] == ["completed"]
    assert findings(db_connection, user_a) == []
