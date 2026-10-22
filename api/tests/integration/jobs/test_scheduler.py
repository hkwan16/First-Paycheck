"""schedule.tick: stale-job requeue and the self-rescheduling tick (spec 002 rule 36)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import Connection, Engine, text

from jobs import scheduler
from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from tests.conftest import FixtureUser
from tests.support.database import upgrade


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def running_job(
    connection: Connection, user: FixtureUser, *, stale_minutes: int, attempts: int = 1
) -> uuid.UUID:
    job_id: uuid.UUID = connection.execute(
        text(
            "INSERT INTO jobs (user_id, kind, status, attempts, started_at, heartbeat_at)"
            " VALUES (:u, 'categorize.run', 'running', :attempts, now(),"
            " now() - make_interval(mins => :stale)) RETURNING id"
        ),
        {"u": user.id, "stale": stale_minutes, "attempts": attempts},
    ).scalar_one()
    return job_id


def status(connection: Connection, job_id: uuid.UUID) -> tuple[str, str | None]:
    row = connection.execute(
        text("SELECT status, last_error FROM jobs WHERE id = :id"), {"id": job_id}
    ).one()
    return row[0], row[1]


def test_tick_requeues_stale_running_jobs(empty_queue: Connection, user_a: FixtureUser) -> None:
    stale = running_job(empty_queue, user_a, stale_minutes=11)
    fresh = running_job(empty_queue, user_a, stale_minutes=2)
    exhausted = running_job(empty_queue, user_a, stale_minutes=30, attempts=5)

    result = scheduler.tick(bind=empty_queue)

    # user_a has no check-in job for this month yet, so the tick queues one (spec 015).
    assert result == {
        "requeued": 1,
        "dead": 1,
        "pruned": 0,
        "expired": 0,
        "checkins_queued": 1,
        "skipped": False,
    }
    assert status(empty_queue, stale) == ("queued", "StaleJob: no heartbeat for 10 minutes")
    assert status(empty_queue, fresh) == ("running", None)
    assert status(empty_queue, exhausted)[0] == "dead"


def test_tick_schedules_the_next_tick_once(empty_queue: Connection) -> None:
    scheduler.tick(bind=empty_queue)
    scheduler.tick(bind=empty_queue)
    queued = empty_queue.execute(
        text(
            "SELECT count(*), min(extract(epoch FROM run_after - now()))::int FROM jobs"
            " WHERE kind = 'schedule.tick' AND status = 'queued'"
        )
    ).one()
    assert tuple(queued) == (1, scheduler.TICK_INTERVAL_SECONDS)


def test_tick_prunes_old_finished_ticks(empty_queue: Connection) -> None:
    empty_queue.execute(
        text(
            "INSERT INTO jobs (kind, status, finished_at) VALUES"
            " ('schedule.tick', 'succeeded', now() - interval '2 hours'),"
            " ('schedule.tick', 'succeeded', now() - interval '5 minutes')"
        )
    )
    assert scheduler.tick(bind=empty_queue)["pruned"] == 1


def test_worker_is_stale_without_any_activity(empty_queue: Connection) -> None:
    assert scheduler.worker_status(bind=empty_queue) == "stale"


@pytest.mark.parametrize(("minutes", "expected"), [(0, "ok"), (4, "ok"), (6, "stale")])
def test_worker_status_follows_the_newest_heartbeat(
    empty_queue: Connection, user_a: FixtureUser, minutes: int, expected: str
) -> None:
    running_job(empty_queue, user_a, stale_minutes=30)
    running_job(empty_queue, user_a, stale_minutes=minutes)
    assert scheduler.worker_status(bind=empty_queue) == expected


def finished(
    connection: Connection,
    kind: str,
    status: str,
    minutes_ago: int,
    user: FixtureUser | None = None,
) -> None:
    connection.execute(
        text(
            "INSERT INTO jobs (user_id, kind, status, finished_at) VALUES (:u,"
            " CAST(:kind AS job_kind), CAST(:status AS job_status),"
            " now() - make_interval(mins => :ago))"
        ),
        {"u": user.id if user else None, "kind": kind, "status": status, "ago": minutes_ago},
    )


@pytest.mark.parametrize(("minutes", "expected"), [(1, "ok"), (6, "stale")])
def test_worker_status_follows_the_last_tick(
    empty_queue: Connection, minutes: int, expected: str
) -> None:
    finished(empty_queue, "schedule.tick", "succeeded", 30)
    finished(empty_queue, "schedule.tick", "succeeded", minutes)
    assert scheduler.worker_status(bind=empty_queue) == expected


def test_only_a_succeeded_tick_or_a_heartbeat_counts(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    # A user job's finish time and a dead tick are not the scheduler running.
    finished(empty_queue, "categorize.run", "succeeded", 1, user_a)
    finished(empty_queue, "schedule.tick", "dead", 1)
    assert scheduler.worker_status(bind=empty_queue) == "stale"


def test_a_ticking_worker_is_ok(empty_queue: Connection) -> None:
    """End to end: the worker claims and completes the tick the way it does in production."""
    scheduler.ensure_tick(bind=empty_queue)
    Worker(
        handlers=default_handlers(),
        services=Services(),
        queue_bind=empty_queue,
        user_bind=empty_queue,
    ).run_once()
    assert scheduler.worker_status(bind=empty_queue) == "ok"


def test_ensure_tick_starts_the_chain_only_once(empty_queue: Connection) -> None:
    assert scheduler.ensure_tick(bind=empty_queue) is True
    assert scheduler.ensure_tick(bind=empty_queue) is False


def test_tick_skips_when_another_scheduler_holds_the_lock(
    scratch_database: tuple[str, Engine],
) -> None:
    url, engine = scratch_database
    upgrade(url, "head")
    with engine.connect() as holder, holder.begin():
        holder.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": scheduler.TICK_LOCK})
        assert scheduler.tick(bind=engine) == {
            "requeued": 0,
            "dead": 0,
            "pruned": 0,
            "expired": 0,
            "checkins_queued": 0,
            "skipped": True,
        }
