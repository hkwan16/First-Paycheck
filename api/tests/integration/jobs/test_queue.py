"""The Postgres job queue (spec 002 rules 32-34)."""

from __future__ import annotations

import threading
import uuid

import pytest
from sqlalchemy import Connection, Engine, text

from app.db import user_session_for
from db.enums import JobKind, JobStatus
from jobs import queue
from jobs.errors import RetryLater
from tests.conftest import USER_A, FixtureUser
from tests.support.database import upgrade


def job_row(connection: Connection, job_id: uuid.UUID) -> dict[str, object]:
    row = connection.execute(
        text(
            "SELECT status, attempts, progress, result, last_error,"
            " extract(epoch FROM run_after - now())::int AS wait,"
            " heartbeat_at IS NOT NULL AS beating, finished_at IS NOT NULL AS finished"
            " FROM jobs WHERE id = :id"
        ),
        {"id": job_id},
    ).one()
    return dict(row._mapping)


def enqueue(
    connection: Connection,
    user: FixtureUser,
    kind: JobKind = JobKind.CATEGORIZE_RUN,
    *,
    payload: dict[str, str] | None = None,
    idempotency_key: str | None = None,
) -> uuid.UUID:
    with user_session_for(user.id, bind=connection) as session:
        return queue.enqueue(
            session, user_id=user.id, kind=kind, payload=payload, idempotency_key=idempotency_key
        )


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    """No committed jobs leak into these tests (rolled back afterwards)."""
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def test_enqueue_runs_under_rls(empty_queue: Connection, user_a: FixtureUser) -> None:
    job_id = enqueue(empty_queue, user_a, payload={"sync_item_id": "x"})
    row = job_row(empty_queue, job_id)
    assert row["status"] == "queued"
    assert row["attempts"] == 0


def test_idempotency_key_dedupes(empty_queue: Connection, user_a: FixtureUser) -> None:
    first = enqueue(empty_queue, user_a, JobKind.SYNC_INITIAL, idempotency_key="sync.initial:1")
    second = enqueue(empty_queue, user_a, JobKind.SYNC_INITIAL, idempotency_key="sync.initial:1")
    assert first == second
    assert empty_queue.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 1


def test_enqueue_unless_queued_reuses_a_waiting_job(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    with user_session_for(user_a.id, bind=empty_queue) as session:
        first = queue.enqueue_unless_queued(
            session,
            user_id=user_a.id,
            kind=JobKind.SYNC_INCREMENTAL,
            payload={"sync_item_id": "i1"},
        )
        same = queue.enqueue_unless_queued(
            session,
            user_id=user_a.id,
            kind=JobKind.SYNC_INCREMENTAL,
            payload={"sync_item_id": "i1"},
        )
        other = queue.enqueue_unless_queued(
            session,
            user_id=user_a.id,
            kind=JobKind.SYNC_INCREMENTAL,
            payload={"sync_item_id": "i2"},
        )
    assert first == same
    assert other != first


def test_dequeue_claims_the_oldest_due_job(empty_queue: Connection, user_a: FixtureUser) -> None:
    later = enqueue(empty_queue, user_a)
    empty_queue.execute(
        text("UPDATE jobs SET run_after = now() + interval '1 hour' WHERE id = :id"), {"id": later}
    )
    due = enqueue(empty_queue, user_a)

    claimed = queue.dequeue(bind=empty_queue)
    assert claimed is not None
    assert claimed.id == due
    assert claimed.user_id == user_a.id
    assert claimed.attempts == 1
    row = job_row(empty_queue, due)
    assert (row["status"], row["beating"]) == ("running", True)
    assert queue.dequeue(bind=empty_queue) is None


def test_complete_records_the_result(empty_queue: Connection, user_a: FixtureUser) -> None:
    enqueue(empty_queue, user_a)
    claimed = queue.dequeue(bind=empty_queue)
    assert claimed is not None
    queue.complete(claimed, {"rule": 3}, bind=empty_queue)
    row = job_row(empty_queue, claimed.id)
    assert (row["status"], row["progress"], row["result"], row["finished"]) == (
        "succeeded",
        100,
        {"rule": 3},
        True,
    )


def test_progress_and_heartbeat(empty_queue: Connection, user_a: FixtureUser) -> None:
    enqueue(empty_queue, user_a)
    claimed = queue.dequeue(bind=empty_queue)
    assert claimed is not None
    queue.set_progress(claimed.id, 40, bind=empty_queue)
    queue.heartbeat(claimed.id, bind=empty_queue)
    assert job_row(empty_queue, claimed.id)["progress"] == 40
    with pytest.raises(ValueError, match="progress"):
        queue.set_progress(claimed.id, 101, bind=empty_queue)


def test_failure_backs_off_then_dies_after_five_attempts(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    job_id = enqueue(empty_queue, user_a)
    waits = []
    for _ in range(queue.MAX_ATTEMPTS):
        empty_queue.execute(
            text("UPDATE jobs SET run_after = now() WHERE id = :id"), {"id": job_id}
        )
        claimed = queue.dequeue(bind=empty_queue)
        assert claimed is not None
        status = queue.fail(claimed, RuntimeError("provider down"), bind=empty_queue)
        row = job_row(empty_queue, job_id)
        waits.append(row["wait"] if status is JobStatus.QUEUED else None)
    assert waits == [60, 120, 240, 480, None]
    row = job_row(empty_queue, job_id)
    assert (row["status"], row["attempts"], row["finished"]) == ("dead", 5, True)
    assert row["last_error"] == "RuntimeError: provider down"


def test_retry_later_uses_its_own_delay(empty_queue: Connection, user_a: FixtureUser) -> None:
    job_id = enqueue(empty_queue, user_a)
    claimed = queue.dequeue(bind=empty_queue)
    assert claimed is not None
    queue.fail(claimed, RetryLater("PRODUCT_NOT_READY", after_seconds=600), bind=empty_queue)
    assert job_row(empty_queue, job_id)["wait"] == 600


def test_a_finished_job_cannot_be_failed_again(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    enqueue(empty_queue, user_a)
    claimed = queue.dequeue(bind=empty_queue)
    assert claimed is not None
    queue.complete(claimed, {}, bind=empty_queue)
    assert queue.fail(claimed, RuntimeError("late"), bind=empty_queue) is None
    assert job_row(empty_queue, claimed.id)["status"] == "succeeded"


# ---------------------------------------------------------------- concurrency


@pytest.fixture
def committed_queue(scratch_database: tuple[str, Engine]) -> Engine:
    """A migrated scratch database whose jobs are committed, for real concurrency."""
    url, engine = scratch_database
    upgrade(url, "head")
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
            {"id": USER_A.id, "email": USER_A.email},
        )
        connection.execute(
            text(
                "INSERT INTO jobs (user_id, kind)"
                " SELECT :u, 'categorize.run' FROM generate_series(1, 60)"
            ),
            {"u": USER_A.id},
        )
    return engine


def test_two_dequeuers_never_share_a_job(committed_queue: Engine) -> None:
    claims: dict[int, list[uuid.UUID]] = {0: [], 1: [], 2: [], 3: []}
    start = threading.Barrier(len(claims))

    def drain(worker: int) -> None:
        start.wait()
        while (job := queue.dequeue(bind=committed_queue)) is not None:
            claims[worker].append(job.id)

    threads = [threading.Thread(target=drain, args=(n,)) for n in claims]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    claimed = [job for jobs in claims.values() for job in jobs]
    assert len(claimed) == 60
    assert len(set(claimed)) == 60
    with committed_queue.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM jobs WHERE status = 'running' AND attempts = 1")
            ).scalar_one()
            == 60
        )
