"""The ``schedule.tick`` system job (spec 002 rule 36).

Each tick runs under ``pg_try_advisory_xact_lock(42)``, so at most one
scheduler acts at a time even with several workers, and the lock goes away
with the transaction if the worker dies. A tick requeues running jobs whose
heartbeat is more than 10 minutes old (as a failed attempt, so the usual
backoff and the 5-attempt limit apply), prunes finished ticks older than an
hour, expires uploads left unconfirmed for 7 days and deletes day-old
rate-limit counters (spec 004 rule 21), and queues the next tick 60 seconds
out. This module may use the privileged connection: it changes rows across
users.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import Connection, text

from app.ratelimit import prune_counters
from db.enums import JobKind, JobStatus
from ingest import store
from jobs import queue
from jobs.context import JobContext
from jobs.queue import ClaimedJob, QueueBind, privileged_connection

TICK_LOCK = 42
TICK_INTERVAL_SECONDS = 60
STALE_AFTER_SECONDS = 600
PRUNE_TICKS_AFTER_SECONDS = 3600


class StaleJob(Exception):
    """A running job stopped sending heartbeats; its worker is presumed dead."""


def _locked(connection: Connection) -> bool:
    return bool(
        connection.execute(
            text("SELECT pg_try_advisory_xact_lock(:k)"), {"k": TICK_LOCK}
        ).scalar_one()
    )


def _requeue_stale(connection: Connection) -> tuple[int, int]:
    rows = connection.execute(
        text(
            "SELECT id, kind, user_id, payload, attempts FROM jobs"
            " WHERE status = 'running'"
            " AND heartbeat_at < now() - make_interval(secs => :stale)"
            " FOR UPDATE SKIP LOCKED"
        ),
        {"stale": STALE_AFTER_SECONDS},
    ).all()
    requeued = dead = 0
    for row in rows:
        job = ClaimedJob(
            id=row.id,
            kind=JobKind(row.kind),
            user_id=row.user_id,
            payload=dict(row.payload),
            attempts=row.attempts,
        )
        status = queue.fail(
            job, StaleJob(f"no heartbeat for {STALE_AFTER_SECONDS // 60} minutes"), bind=connection
        )
        if status is JobStatus.DEAD:
            dead += 1
        elif status is not None:
            requeued += 1
    return requeued, dead


def tick(*, bind: QueueBind | None = None, now: dt.datetime | None = None) -> dict[str, Any]:
    now = now or dt.datetime.now(dt.UTC)
    with privileged_connection(bind) as connection:
        if not _locked(connection):
            return {"requeued": 0, "dead": 0, "pruned": 0, "expired": 0, "skipped": True}
        requeued, dead = _requeue_stale(connection)
        pruned = connection.execute(
            text(
                "DELETE FROM jobs WHERE kind = 'schedule.tick' AND status = 'succeeded'"
                " AND finished_at < now() - make_interval(secs => :age)"
            ),
            {"age": PRUNE_TICKS_AFTER_SECONDS},
        ).rowcount
        # Retention (spec 004 rule 21): unconfirmed uploads go after 7 days.
        expired = store.expire_unconfirmed(connection, now=now)
        prune_counters(connection, now=now)
        connection.execute(
            text(
                "INSERT INTO jobs (kind, run_after)"
                " SELECT 'schedule.tick', now() + make_interval(secs => :interval)"
                " WHERE NOT EXISTS ("
                "   SELECT 1 FROM jobs WHERE kind = 'schedule.tick' AND status = 'queued')"
            ),
            {"interval": TICK_INTERVAL_SECONDS},
        )
    return {
        "requeued": requeued,
        "dead": dead,
        "pruned": pruned,
        "expired": expired,
        "skipped": False,
    }


def ensure_tick(*, bind: QueueBind | None = None) -> bool:
    """Start the tick chain when no tick is queued or running. True when one was queued."""
    with privileged_connection(bind) as connection:
        connection.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": TICK_LOCK})
        inserted = connection.execute(
            text(
                "INSERT INTO jobs (kind) SELECT 'schedule.tick' WHERE NOT EXISTS ("
                "  SELECT 1 FROM jobs WHERE kind = 'schedule.tick'"
                "  AND status IN ('queued', 'running'))"
                " RETURNING id"
            )
        ).first()
    return inserted is not None


def run_tick(ctx: JobContext) -> dict[str, Any]:
    """The ``schedule.tick`` handler."""
    return tick(bind=ctx.queue_bind)
