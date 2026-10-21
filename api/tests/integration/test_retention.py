"""The scheduler tick deletes unconfirmed uploads after 7 days and old
rate-limit counters (spec 004 rule 21), at a frozen time."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import Connection, text

from jobs import scheduler
from tests.conftest import FixtureUser
from tests.support.factories import make_document

NOW = dt.datetime(2026, 11, 20, 12, 0, tzinfo=dt.UTC)
DAY = dt.timedelta(days=1)


def document(
    connection: Connection, user: FixtureUser, age: dt.timedelta, **fields: Any
) -> uuid.UUID:
    return make_document(connection, user.id, created_at=NOW - age, **fields)


def state(connection: Connection, document_id: uuid.UUID) -> tuple[str, str | None, bool, bool]:
    row = connection.execute(
        text(
            "SELECT status::text, status_reason::text, deleted_at = :now AS deleted_now,"
            " EXISTS (SELECT 1 FROM document_blobs b WHERE b.document_id = d.id) AS has_blob"
            " FROM documents d WHERE id = :id"
        ),
        {"id": document_id, "now": NOW},
    ).one()
    return (row.status, row.status_reason, bool(row.deleted_now), row.has_blob)


def test_tick_expires_week_old_unconfirmed_uploads(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    stale_upload = document(db_connection, user_a, 8 * DAY)
    stale_proposal = document(
        db_connection, user_b, 8 * DAY, status="proposed", proposal={"fields": []}
    )
    stale_manual = document(
        db_connection,
        user_a,
        7 * DAY + dt.timedelta(seconds=1),
        status="manual_entry_required",
        status_reason="refused",
    )
    recent = document(db_connection, user_a, 6 * DAY)

    result = scheduler.tick(bind=db_connection, now=NOW)

    assert result["expired"] == 3
    for expired in (stale_upload, stale_proposal, stale_manual):
        assert state(db_connection, expired) == ("failed", "expired", True, False)
    assert state(db_connection, recent) == ("uploaded", None, False, True)
    # Nothing is left to expire on the next tick.
    assert scheduler.tick(bind=db_connection, now=NOW)["expired"] == 0


def test_tick_prunes_day_old_rate_limit_counters(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    for started in (
        NOW - 2 * DAY,
        NOW - DAY - dt.timedelta(minutes=1),
        NOW - DAY + dt.timedelta(minutes=1),
        NOW,
    ):
        db_connection.execute(
            text(
                "INSERT INTO rate_limit_counters (user_id, bucket, window_start, count)"
                " VALUES (:u, 'docs.upload', :w, 1)"
            ),
            {"u": user_a.id, "w": started},
        )
    scheduler.tick(bind=db_connection, now=NOW)
    kept = (
        db_connection.execute(
            text("SELECT window_start FROM rate_limit_counters ORDER BY window_start")
        )
        .scalars()
        .all()
    )
    assert kept == [NOW - DAY + dt.timedelta(minutes=1), NOW]
