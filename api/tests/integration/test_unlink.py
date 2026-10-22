"""Unlinking leaves no orphans and no stale derived data (spec 017 rules 11-16).

The November user (spec 015) banks at two institutions. Equinox is billed to a
checking account at the first, which also holds the emergency-fund savings;
Netflix is billed at the second. The month's check-in reports both charges and
the goal behind pace. Unlinking the first institution through the API, then
letting the worker run what it queued, must leave nothing that came from it.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Connection, text

from app.config import get_settings
from app.db import user_session_for
from app.deps import get_optional_plaid_client, get_plaid_client
from app.errors import AppError
from db.enums import AccountKind, JobKind
from jobs import queue
from sync.crypto import cipher_from_settings
from tests.conftest import FixtureUser
from tests.integration.checkin.test_checkin_job import findings, queue_check_in, run_all
from tests.support.factories import (
    make_account,
    make_holding,
    make_item,
    make_snapshot,
    make_transaction,
)
from tests.support.fake_plaid import FakePlaidClient
from tests.support.november import November, november

Client = Callable[[FixtureUser], TestClient]


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def monthly(
    connection: Connection,
    user: FixtureUser,
    account: uuid.UUID,
    merchant: str,
    cents: int,
    days: tuple[dt.date, ...],
) -> None:
    for day in days:
        make_transaction(
            connection, user.id, account, merchant_raw=merchant, amount_cents=cents, posted_at=day
        )


def detect(connection: Connection, user: FixtureUser) -> None:
    with user_session_for(user.id, bind=connection) as session:
        queue.enqueue(session, user_id=user.id, kind=JobKind.RECURRING_DETECT)
    run_all(connection)


def count(connection: Connection, sql: str, **params: object) -> int:
    return int(connection.execute(text(sql), params).scalar_one())


def queued_jobs(connection: Connection) -> list[tuple[uuid.UUID, str]]:
    rows = connection.execute(
        text("SELECT id, kind::text FROM jobs WHERE status = 'queued' ORDER BY created_at, id")
    )
    return [(row[0], row[1]) for row in rows]


@pytest.fixture
def two_banks(empty_queue: Connection, user_a: FixtureUser) -> tuple[November, uuid.UUID]:
    """The November user with Equinox and the savings at the first bank,
    Netflix at a second, and the month's check-in already built."""
    seeded = november(empty_queue, user_a)
    first_bank = empty_queue.execute(
        text("SELECT sync_item_id FROM accounts WHERE id = :id"), {"id": seeded.savings}
    ).scalar_one()
    checking = make_account(empty_queue, user_a.id, first_bank, name="Chase Checking")
    monthly(
        empty_queue,
        user_a,
        checking,
        "EQUINOX #0412",
        18_500,
        (dt.date(2026, 9, 3), dt.date(2026, 10, 3), dt.date(2026, 11, 3)),
    )
    brokerage = make_account(
        empty_queue, user_a.id, first_bank, kind=AccountKind.INVESTMENT, name="Chase Invest"
    )
    make_holding(empty_queue, user_a.id, brokerage)
    make_snapshot(empty_queue, user_a.id, checking, balance_cents=120_000)

    second_bank = make_item(empty_queue, user_a.id, institution_name="Second Bank")
    card = make_account(empty_queue, user_a.id, second_bank, kind=AccountKind.CREDIT, name="Card")
    monthly(
        empty_queue,
        user_a,
        card,
        "NETFLIX.COM",
        1_549,
        (dt.date(2026, 9, 10), dt.date(2026, 10, 10), dt.date(2026, 11, 10)),
    )

    detect(empty_queue, user_a)
    queue_check_in(empty_queue, user_a)
    run_all(empty_queue)
    return seeded, first_bank


def finding_kinds(connection: Connection, user: FixtureUser) -> list[tuple[str, str]]:
    """(kind, merchant or "") of each finding, sorted."""
    return sorted(
        (row["kind"], row["payload"].get("merchant") or "") for row in findings(connection, user)
    )


def test_the_check_in_reports_both_banks_before_unlinking(
    two_banks: tuple[November, uuid.UUID], empty_queue: Connection, user_a: FixtureUser
) -> None:
    kinds = finding_kinds(empty_queue, user_a)
    assert ("recurring_new", "Equinox") in kinds
    assert ("recurring_new", "NETFLIX.COM") in kinds
    assert ("goal_off_pace", "") in kinds


def test_unlink_retracts_what_came_from_the_item_on_the_next_refresh(
    two_banks: tuple[November, uuid.UUID],
    empty_queue: Connection,
    client_as: Client,
    user_a: FixtureUser,
) -> None:
    seeded, first_bank = two_banks
    before = finding_kinds(empty_queue, user_a)

    response = client_as(user_a).delete(f"/sync/items/{first_bank}")
    assert response.status_code == 200, response.text
    assert queued_jobs(empty_queue) == [
        (uuid.UUID(response.json()["recurring_job_id"]), "recurring.detect")
    ]
    run_all(empty_queue)  # recurring.detect, then the check-in refresh it queues

    # Spec 001 rule 25: the item's rows are gone; the goal stays, unlinked.
    accounts = empty_queue.execute(
        text("SELECT name FROM accounts WHERE user_id = :u"), {"u": user_a.id}
    ).scalars()
    assert list(accounts) == ["Card"]
    assert (
        count(empty_queue, "SELECT count(*) FROM transactions WHERE user_id = :u", u=user_a.id) == 3
    )
    for name in ("balance_snapshots", "holdings"):
        rows = count(
            empty_queue,
            f"SELECT count(*) FROM {name} WHERE user_id = :u",  # noqa: S608 (a fixed table name)
            u=user_a.id,
        )
        assert rows == 0, name
    goal_account = empty_queue.execute(
        text("SELECT account_id FROM goals WHERE id = :id"), {"id": seeded.goal}
    ).scalar_one()
    assert goal_account is None

    # Spec 009 rule 16: Equinox has no charges left, so detection dropped it.
    merchants = set(
        empty_queue.execute(
            text("SELECT merchant_norm FROM recurring_charges WHERE user_id = :u"), {"u": user_a.id}
        ).scalars()
    )
    assert merchants == {"netflix.com"}

    # Spec 015 rule 10.4: findings about the item's data are retracted, the
    # rest are kept.
    after = finding_kinds(empty_queue, user_a)
    assert ("recurring_new", "Equinox") not in after
    assert ("goal_off_pace", "") not in after
    assert set(after) == set(before) - {("recurring_new", "Equinox"), ("goal_off_pace", "")}
    assert ("recurring_new", "NETFLIX.COM") in after


def test_a_handled_finding_about_the_item_is_kept_as_history(
    two_banks: tuple[November, uuid.UUID],
    empty_queue: Connection,
    client_as: Client,
    user_a: FixtureUser,
) -> None:
    _, first_bank = two_banks
    empty_queue.execute(
        text(
            "UPDATE check_in_findings SET user_action = 'dismissed', user_action_at = now()"
            " WHERE user_id = :u AND payload->>'merchant' = 'Equinox'"
        ),
        {"u": user_a.id},
    )

    assert client_as(user_a).delete(f"/sync/items/{first_bank}").status_code == 200
    run_all(empty_queue)

    assert ("recurring_new", "Equinox") in finding_kinds(empty_queue, user_a)


def test_a_sync_queued_for_the_item_finds_it_missing(
    two_banks: tuple[November, uuid.UUID],
    empty_queue: Connection,
    client_as: Client,
    user_a: FixtureUser,
) -> None:
    """Spec 002 rule 17: the job succeeds as ``item_missing`` and writes nothing."""
    _, first_bank = two_banks
    with user_session_for(user_a.id, bind=empty_queue) as session:
        job = queue.enqueue(
            session,
            user_id=user_a.id,
            kind=JobKind.SYNC_INCREMENTAL,
            payload={"sync_item_id": str(first_bank)},
        )

    assert client_as(user_a).delete(f"/sync/items/{first_bank}").status_code == 200
    run_all(empty_queue)

    status, result = empty_queue.execute(
        text("SELECT status::text, result FROM jobs WHERE id = :id"), {"id": job}
    ).one()
    assert (status, result["outcome"]) == ("succeeded", "item_missing")


class SpyingPlaid(FakePlaidClient):
    """Records whether the test connection had a savepoint open during the call."""

    def __init__(self, connection: Connection) -> None:
        super().__init__()
        self.connection = connection
        self.in_transaction: list[bool] = []

    def item_remove(self, access_token: SecretStr) -> None:
        # The request's sessions are savepoints on the test connection.
        self.in_transaction.append(self.connection.in_nested_transaction())
        super().item_remove(access_token)


def test_unlink_removes_the_item_at_plaid_with_no_transaction_open(
    app: FastAPI, empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    plaid = SpyingPlaid(empty_queue)
    app.dependency_overrides[get_optional_plaid_client] = lambda: plaid
    token = cipher_from_settings(get_settings()).encrypt(SecretStr("access-unlink"))
    item = make_item(empty_queue, user_a.id, access_token_enc=token)

    assert client_as(user_a).delete(f"/sync/items/{item}").status_code == 200

    assert plaid.removed == ["access-unlink"]
    assert plaid.in_transaction == [False]
    assert count(empty_queue, "SELECT count(*) FROM sync_items WHERE id = :i", i=item) == 0


def test_unlink_without_plaid_configured_still_deletes(
    app: FastAPI, empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    app.dependency_overrides[get_optional_plaid_client] = lambda: None
    app.dependency_overrides[get_plaid_client] = _unconfigured
    token = cipher_from_settings(get_settings()).encrypt(SecretStr("access-unlink"))
    item = make_item(empty_queue, user_a.id, access_token_enc=token)

    assert client_as(user_a).delete(f"/sync/items/{item}").status_code == 200
    assert count(empty_queue, "SELECT count(*) FROM sync_items WHERE id = :i", i=item) == 0


def test_unlink_returns_the_recurring_job_and_a_repeat_is_404(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Spec 017 example 15: the client follows the job; a second unlink finds nothing."""
    item = make_item(empty_queue, user_a.id)
    client = client_as(user_a)

    first = client.delete(f"/sync/items/{item}")

    assert first.status_code == 200, first.text
    assert set(first.json()) == {"recurring_job_id"}
    job_id = uuid.UUID(first.json()["recurring_job_id"])
    assert queued_jobs(empty_queue) == [(job_id, "recurring.detect")]
    assert client.get(f"/jobs/{job_id}").json()["kind"] == "recurring.detect"

    again = client.delete(f"/sync/items/{item}")

    assert again.status_code == 404
    assert again.json()["error"]["code"] == "not_found"
    assert queued_jobs(empty_queue) == [(job_id, "recurring.detect")]


def test_unlink_returns_the_detection_already_queued(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """A detection already waiting covers the unlink too, so the route returns it."""
    with user_session_for(user_a.id, bind=empty_queue) as session:
        waiting = queue.enqueue(session, user_id=user_a.id, kind=JobKind.RECURRING_DETECT)
    item = make_item(empty_queue, user_a.id)

    response = client_as(user_a).delete(f"/sync/items/{item}")

    assert response.status_code == 200, response.text
    assert response.json() == {"recurring_job_id": str(waiting)}
    assert queued_jobs(empty_queue) == [(waiting, "recurring.detect")]


def _unconfigured() -> FakePlaidClient:
    raise AppError("Bank linking is not configured", code="plaid_unavailable", status_code=503)
