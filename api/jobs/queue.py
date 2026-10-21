"""The Postgres job queue (spec 002 rules 32-36).

``enqueue`` runs in the caller's user session, under RLS. Everything else
(dequeue, progress, heartbeat, completion, failure) changes rows across users
and runs on the privileged connection: this module is one of the two places
where cross-user SQL is allowed (spec amendment 9).

Every privileged function takes an optional ``bind``. ``None`` means the
privileged engine; tests pass a connection inside their own transaction, and
the function then works in a savepoint.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session

from app.db import get_privileged_engine
from db.enums import JobKind, JobStatus
from jobs.errors import RetryLater

MAX_ATTEMPTS = 5
BASE_BACKOFF_SECONDS = 30
MAX_BACKOFF_SECONDS = 3600
MAX_ERROR_LENGTH = 500

QueueBind = Engine | Connection


@dataclass(frozen=True)
class ClaimedJob:
    id: uuid.UUID
    kind: JobKind
    user_id: uuid.UUID | None
    payload: dict[str, Any]
    attempts: int


def backoff_seconds(attempts: int) -> int:
    """Delay after the ``attempts``-th failed attempt: min(2^n * 30 s, 1 h)."""
    return min(2 ** min(attempts, 16) * BASE_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS)


def retry_delay(attempts: int, error: BaseException) -> int:
    floor = error.after_seconds if isinstance(error, RetryLater) else 0
    return max(backoff_seconds(attempts), floor)


def error_text(error: BaseException) -> str:
    """What ``last_error`` stores: the type and message, never more than 500 characters."""
    return f"{type(error).__name__}: {error}"[:MAX_ERROR_LENGTH]


# ---------------------------------------------------------------- enqueue (user session)

_INSERT = text(
    """
    INSERT INTO jobs (user_id, kind, payload, idempotency_key, run_after)
    VALUES (:user_id, :kind, CAST(:payload AS jsonb), :key, coalesce(:run_after, now()))
    ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id
    """
)


def enqueue(
    session: Session,
    *,
    user_id: uuid.UUID,
    kind: JobKind,
    payload: Mapping[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> uuid.UUID:
    """Queue a job for ``user_id`` inside ``session`` (a user session, so RLS applies).

    With an idempotency key, a second call returns the first job's id.
    """
    params = {
        "user_id": user_id,
        "kind": kind.value,
        "payload": json.dumps(dict(payload or {}), sort_keys=True),
        "key": idempotency_key,
        "run_after": None,
    }
    job_id: uuid.UUID | None = session.execute(_INSERT, params).scalar()
    if job_id is not None:
        return job_id
    existing: uuid.UUID = session.execute(
        text("SELECT id FROM jobs WHERE user_id = :user_id AND idempotency_key = :key"),
        params,
    ).scalar_one()
    return existing


def enqueue_unless_queued(
    session: Session,
    *,
    user_id: uuid.UUID,
    kind: JobKind,
    payload: Mapping[str, Any] | None = None,
) -> uuid.UUID:
    """Return the user's queued job of ``kind`` with the same payload, or queue one.

    Keeps repeated triggers (a sync per webhook, a categorize run per sync)
    from piling up while the first is still waiting.
    """
    payload_json = json.dumps(dict(payload or {}), sort_keys=True)
    waiting: uuid.UUID | None = session.execute(
        text(
            "SELECT id FROM jobs WHERE user_id = :user_id AND kind = :kind"
            " AND status = 'queued' AND payload = CAST(:payload AS jsonb)"
            " ORDER BY created_at LIMIT 1"
        ),
        {"user_id": user_id, "kind": kind.value, "payload": payload_json},
    ).scalar()
    if waiting is not None:
        return waiting
    return enqueue(session, user_id=user_id, kind=kind, payload=payload)


# ---------------------------------------------------------------- privileged side


@contextmanager
def privileged_connection(bind: QueueBind | None) -> Iterator[Connection]:
    """A privileged transaction: on ``bind``, else on the privileged engine.

    A connection already in a transaction (tests, the scheduler) gets a savepoint.
    """
    if bind is None:
        bind = get_privileged_engine()
    if isinstance(bind, Engine):
        with bind.begin() as connection:
            yield connection
    elif bind.in_transaction():
        with bind.begin_nested():
            yield bind
    else:
        with bind.begin():
            yield bind


_CLAIM = text(
    """
    UPDATE jobs
    SET status = 'running', attempts = attempts + 1,
        started_at = now(), heartbeat_at = now(), finished_at = NULL
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY run_after, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, kind, user_id, payload, attempts
    """
)


def dequeue(*, bind: QueueBind | None = None) -> ClaimedJob | None:
    """Claim the oldest due job. Concurrent callers never claim the same one."""
    with privileged_connection(bind) as connection:
        row = connection.execute(_CLAIM).one_or_none()
    if row is None:
        return None
    return ClaimedJob(
        id=row.id,
        kind=JobKind(row.kind),
        user_id=row.user_id,
        payload=dict(row.payload),
        attempts=row.attempts,
    )


def complete(job: ClaimedJob, result: Mapping[str, Any], *, bind: QueueBind | None = None) -> None:
    with privileged_connection(bind) as connection:
        connection.execute(
            text(
                "UPDATE jobs SET status = 'succeeded', progress = 100,"
                " result = CAST(:result AS jsonb), finished_at = now(), heartbeat_at = NULL"
                " WHERE id = :id AND status = 'running'"
            ),
            {"id": job.id, "result": json.dumps(dict(result), sort_keys=True, default=str)},
        )


def fail(
    job: ClaimedJob, error: BaseException, *, bind: QueueBind | None = None
) -> JobStatus | None:
    """Record a failed attempt: back off and requeue, or mark the job dead.

    Returns the new status, or None when the job was no longer running (it
    already finished, or the scheduler requeued it).
    """
    dead = job.attempts >= MAX_ATTEMPTS
    with privileged_connection(bind) as connection:
        status: str | None = connection.execute(
            text(
                "UPDATE jobs SET status = CAST(:status AS job_status), last_error = :error,"
                " heartbeat_at = NULL,"
                " run_after = CASE WHEN :dead THEN run_after"
                "   ELSE now() + make_interval(secs => :delay) END,"
                " finished_at = CASE WHEN :dead THEN now() ELSE NULL END"
                " WHERE id = :id AND status = 'running' RETURNING status"
            ),
            {
                "id": job.id,
                "status": (JobStatus.DEAD if dead else JobStatus.QUEUED).value,
                "dead": dead,
                "delay": retry_delay(job.attempts, error),
                "error": error_text(error),
            },
        ).scalar()
    return JobStatus(status) if status is not None else None


def set_progress(job_id: uuid.UUID, percent: int, *, bind: QueueBind | None = None) -> None:
    if not 0 <= percent <= 100:
        raise ValueError("progress must be 0-100")
    with privileged_connection(bind) as connection:
        connection.execute(
            text(
                "UPDATE jobs SET progress = :p, heartbeat_at = now()"
                " WHERE id = :id AND status = 'running'"
            ),
            {"id": job_id, "p": percent},
        )


def heartbeat(job_id: uuid.UUID, *, bind: QueueBind | None = None) -> None:
    with privileged_connection(bind) as connection:
        connection.execute(
            text("UPDATE jobs SET heartbeat_at = now() WHERE id = :id AND status = 'running'"),
            {"id": job_id},
        )
