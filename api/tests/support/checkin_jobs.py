"""Running and reading ``checkin.monthly`` jobs in tests (spec 015)."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import Connection, text

from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from tests.conftest import FixtureUser
from tests.support.november import NOW

Row = dict[str, Any]


def run_all(connection: Connection, now: dt.datetime = NOW) -> None:
    worker = Worker(
        handlers=default_handlers(),
        services=Services(clock=lambda: now),
        queue_bind=connection,
        user_bind=connection,
    )
    while worker.run_once():
        pass


def job_row(connection: Connection, job_id: uuid.UUID) -> Row:
    row = connection.execute(
        text("SELECT status::text, result, last_error FROM jobs WHERE id = :id"), {"id": job_id}
    ).one()
    return dict(row._mapping)


def check_ins(connection: Connection, user: FixtureUser) -> list[Row]:
    rows = connection.execute(
        text(
            "SELECT id, period, triggered_by::text, status::text, last_run_at FROM check_ins"
            " WHERE user_id = :u ORDER BY period"
        ),
        {"u": user.id},
    ).all()
    return [dict(row._mapping) for row in rows]


def findings(connection: Connection, user: FixtureUser) -> list[Row]:
    rows = connection.execute(
        text(
            "SELECT id, kind::text, severity::text, key, payload, user_action::text"
            " FROM check_in_findings WHERE user_id = :u ORDER BY created_at, key"
        ),
        {"u": user.id},
    ).all()
    return [dict(row._mapping) for row in rows]


def checkin_jobs(connection: Connection) -> list[Row]:
    rows = connection.execute(
        text(
            "SELECT user_id, idempotency_key, payload, status::text FROM jobs"
            " WHERE kind = 'checkin.monthly' ORDER BY user_id, created_at"
        )
    ).all()
    return [dict(row._mapping) for row in rows]
