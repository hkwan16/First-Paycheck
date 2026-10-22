"""The recurring.detect job against Postgres (spec 009 rules 11-16, job examples)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.db import user_session_for
from db.enums import JobKind
from jobs import queue
from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from sync.recurring import DetectionResult, run_detection
from tests.conftest import FixtureUser
from tests.support.factories import make_account, make_item, make_transaction

TODAY = dt.date(2026, 10, 21)
NETFLIX_DAYS = ("2026-07-03", "2026-08-03", "2026-09-03", "2026-10-03")
UBER_RIDES = (
    ("Uber 063015 SF**POOL**", "2026-08-12", 540),
    ("Uber 063015 SF**POOL**", "2026-09-11", 540),
    ("Uber 063015 SF**POOL**", "2026-10-11", 540),
    ("Uber 072515 SF**POOL**", "2026-07-26", 633),
    ("Uber 072515 SF**POOL**", "2026-08-25", 633),
    ("Uber 072515 SF**POOL**", "2026-09-24", 633),
)


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def account_for(connection: Connection, user: FixtureUser) -> uuid.UUID:
    return make_account(connection, user.id, make_item(connection, user.id))


def charge(
    connection: Connection,
    user: FixtureUser,
    account: uuid.UUID,
    day: str,
    amount_cents: int = 1549,
    merchant_raw: str = "NETFLIX.COM",
) -> None:
    make_transaction(
        connection,
        user.id,
        account,
        merchant_raw=merchant_raw,
        amount_cents=amount_cents,
        posted_at=dt.date.fromisoformat(day),
    )


def netflix(connection: Connection, user: FixtureUser, account: uuid.UUID) -> None:
    for day in NETFLIX_DAYS:
        charge(connection, user, account, day)


def detect_as(connection: Connection, user: FixtureUser, today: dt.date) -> DetectionResult:
    with user_session_for(user.id, bind=connection) as session:
        return run_detection(session, user.id, today)


def rows(connection: Connection, user: FixtureUser) -> list[dict[str, Any]]:
    result = connection.execute(
        text(
            "SELECT merchant_norm, merchant_clean, cadence::text AS cadence,"
            " typical_amount_cents, first_seen, last_seen, status::text AS status,"
            " user_status::text AS user_status"
            " FROM recurring_charges WHERE user_id = :u ORDER BY merchant_norm"
        ),
        {"u": user.id},
    )
    return [dict(row._mapping) for row in result]


def run_queued(connection: Connection, today: dt.date) -> dict[str, Any]:
    clock: Callable[[], dt.datetime] = lambda: dt.datetime.combine(  # noqa: E731
        today, dt.time(12), tzinfo=dt.UTC
    )
    worker = Worker(
        handlers=default_handlers(),
        services=Services(clock=clock),
        queue_bind=connection,
        user_bind=connection,
    )
    assert worker.run_once()
    row = connection.execute(
        text(
            "SELECT id, status::text AS status, result FROM jobs WHERE kind = 'recurring.detect'"
            " ORDER BY finished_at DESC NULLS LAST LIMIT 1"
        )
    ).one()
    return dict(row._mapping)


def test_detect_job_writes_new_charges(empty_queue: Connection, user_a: FixtureUser) -> None:
    account = account_for(empty_queue, user_a)
    netflix(empty_queue, user_a, account)
    for raw, day, amount in UBER_RIDES:
        charge(empty_queue, user_a, account, day, amount, raw)
    with user_session_for(user_a.id, bind=empty_queue) as session:
        queue.enqueue(session, user_id=user_a.id, kind=JobKind.RECURRING_DETECT)

    job = run_queued(empty_queue, TODAY)

    assert job["status"] == "succeeded"
    assert job["result"] == {"detected": 1, "new": 1, "changed": 0, "stopped": 0, "deleted": 0}
    assert rows(empty_queue, user_a) == [
        {
            "merchant_norm": "netflix.com",
            "merchant_clean": "NETFLIX.COM",
            "cadence": "monthly",
            "typical_amount_cents": 1549,
            "first_seen": dt.date(2026, 7, 3),
            "last_seen": dt.date(2026, 10, 3),
            "status": "new",
            "user_status": None,
        }
    ]


def test_rerun_keeps_the_flag_and_the_rename(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    netflix(db_connection, user_a, account_for(db_connection, user_a))
    detect_as(db_connection, user_a, TODAY)
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(text("UPDATE recurring_charges SET merchant_clean = 'Netflix'"))

    again = detect_as(db_connection, user_a, TODAY)

    assert again == DetectionResult(detected=1)
    [row] = rows(db_connection, user_a)
    assert (row["merchant_clean"], row["status"]) == ("Netflix", "new")


def test_charge_stops_and_resumes(db_connection: Connection, user_a: FixtureUser) -> None:
    account = account_for(db_connection, user_a)
    netflix(db_connection, user_a, account)
    detect_as(db_connection, user_a, TODAY)

    stopped = detect_as(db_connection, user_a, dt.date(2026, 11, 12))
    assert stopped == DetectionResult(detected=1, stopped=1)
    assert rows(db_connection, user_a)[0]["status"] == "stopped"

    charge(db_connection, user_a, account, "2026-11-13")
    resumed = detect_as(db_connection, user_a, dt.date(2026, 11, 14))
    assert resumed == DetectionResult(detected=1, new=1)
    [row] = rows(db_connection, user_a)
    assert (row["status"], row["last_seen"]) == ("new", dt.date(2026, 11, 13))


def test_price_change_marks_an_active_charge_changed(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    account = account_for(db_connection, user_a)
    netflix(db_connection, user_a, account)
    detect_as(db_connection, user_a, TODAY)
    # The check-in (M8) acknowledges flags; stand in for it.
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(text("UPDATE recurring_charges SET status = 'active'"))
    charge(db_connection, user_a, account, "2026-11-03", 1699)
    charge(db_connection, user_a, account, "2026-12-03", 1699)

    result = detect_as(db_connection, user_a, dt.date(2026, 12, 5))

    assert result == DetectionResult(detected=1, changed=1)
    [row] = rows(db_connection, user_a)
    assert (row["status"], row["typical_amount_cents"]) == ("changed", 1699)


def test_unlinking_deletes_its_charges(
    empty_queue: Connection,
    client_as: Callable[[FixtureUser], TestClient],
    user_a: FixtureUser,
) -> None:
    item = make_item(empty_queue, user_a.id)
    netflix(empty_queue, user_a, make_account(empty_queue, user_a.id, item))
    detect_as(empty_queue, user_a, TODAY)
    assert len(rows(empty_queue, user_a)) == 1

    response = client_as(user_a).delete(f"/sync/items/{item}")
    assert response.status_code == 200
    job = run_queued(empty_queue, TODAY)
    assert job["id"] == uuid.UUID(response.json()["recurring_job_id"])

    assert job["result"] == {"detected": 0, "new": 0, "changed": 0, "stopped": 0, "deleted": 1}
    assert rows(empty_queue, user_a) == []


def test_a_merchant_without_a_series_keeps_its_row_until_overdue(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    account = account_for(db_connection, user_a)
    netflix(db_connection, user_a, account)
    detect_as(db_connection, user_a, TODAY)
    # Two charges left are too few for a series, but the merchant still has charges.
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(
            text("DELETE FROM transactions WHERE posted_at IN ('2026-07-03', '2026-08-03')")
        )

    assert detect_as(db_connection, user_a, TODAY) == DetectionResult()
    assert rows(db_connection, user_a)[0]["status"] == "new"
    assert detect_as(db_connection, user_a, dt.date(2026, 11, 12)) == DetectionResult(stopped=1)


def test_only_the_users_transactions_count(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    netflix(db_connection, user_b, account_for(db_connection, user_b))

    assert detect_as(db_connection, user_a, TODAY) == DetectionResult()
    assert rows(db_connection, user_a) == []
    assert rows(db_connection, user_b) == []


def test_pending_and_hidden_accounts_are_ignored(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    hidden = make_account(db_connection, user_a.id, make_item(db_connection, user_a.id))
    netflix(db_connection, user_a, hidden)
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(text("UPDATE accounts SET is_active = false WHERE id = :a"), {"a": hidden})
    visible = account_for(db_connection, user_a)
    for day in NETFLIX_DAYS:
        make_transaction(
            db_connection,
            user_a.id,
            visible,
            merchant_raw="SPOTIFY",
            amount_cents=1199,
            posted_at=dt.date.fromisoformat(day),
            pending=True,
        )

    assert detect_as(db_connection, user_a, TODAY) == DetectionResult()
