"""The worker loop: claim, run the handler as the job's user, record the outcome."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Mapping
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, text

from app.config import REPO_ROOT
from app.db import user_session_for
from db.enums import JobKind
from jobs import queue
from jobs.context import JobContext, Services
from jobs.errors import RetryLater
from jobs.registry import Handler, default_handlers
from jobs.worker import Worker
from tests.conftest import USER_A, FixtureUser
from tests.support.database import upgrade


def enqueue(connection: Connection, user: FixtureUser, kind: JobKind) -> uuid.UUID:
    with user_session_for(user.id, bind=connection) as session:
        return queue.enqueue(session, user_id=user.id, kind=kind, payload={"n": 1})


def job(connection: Connection, job_id: uuid.UUID) -> dict[str, Any]:
    row = connection.execute(
        text("SELECT status, result, last_error, attempts FROM jobs WHERE id = :id"),
        {"id": job_id},
    ).one()
    return dict(row._mapping)


def worker_for(connection: Connection, handlers: Mapping[JobKind, Handler]) -> Worker:
    return Worker(
        handlers=handlers, services=Services(), queue_bind=connection, user_bind=connection
    )


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def test_handler_runs_as_the_jobs_user(empty_queue: Connection, user_a: FixtureUser) -> None:
    seen: dict[str, Any] = {}

    def handler(ctx: JobContext) -> dict[str, Any]:
        with ctx.user_session() as session:
            seen["uid"] = session.execute(text("SELECT public.current_user_id()")).scalar_one()
            seen["role"] = session.execute(text("SELECT current_user")).scalar_one()
        ctx.progress(50)
        return {"payload": ctx.job.payload}

    job_id = enqueue(empty_queue, user_a, JobKind.CATEGORIZE_RUN)
    assert worker_for(empty_queue, {JobKind.CATEGORIZE_RUN: handler}).run_once() is True
    assert seen == {"uid": user_a.id, "role": "authenticated"}
    assert job(empty_queue, job_id)["status"] == "succeeded"
    assert job(empty_queue, job_id)["result"] == {"payload": {"n": 1}}


def test_a_failing_handler_backs_off(empty_queue: Connection, user_a: FixtureUser) -> None:
    def handler(ctx: JobContext) -> dict[str, Any]:
        raise RuntimeError("plaid is down")

    job_id = enqueue(empty_queue, user_a, JobKind.CATEGORIZE_RUN)
    assert worker_for(empty_queue, {JobKind.CATEGORIZE_RUN: handler}).run_once() is True
    row = job(empty_queue, job_id)
    assert (row["status"], row["last_error"], row["attempts"]) == (
        "queued",
        "RuntimeError: plaid is down",
        1,
    )


def test_handler_writes_roll_back_when_it_fails(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    def handler(ctx: JobContext) -> dict[str, Any]:
        with ctx.user_session() as session:
            session.execute(
                text(
                    "INSERT INTO category_rules (user_id, merchant_norm, match, category, source)"
                    " VALUES (:u, 'half written', 'exact', 'other', 'user')"
                ),
                {"u": ctx.user_id},
            )
            raise RetryLater("not ready", after_seconds=120)

    enqueue(empty_queue, user_a, JobKind.CATEGORIZE_RUN)
    worker_for(empty_queue, {JobKind.CATEGORIZE_RUN: handler}).run_once()
    assert (
        empty_queue.execute(
            text("SELECT count(*) FROM category_rules WHERE merchant_norm = 'half written'")
        ).scalar_one()
        == 0
    )


def test_unknown_kind_fails_the_job(empty_queue: Connection, user_a: FixtureUser) -> None:
    job_id = enqueue(empty_queue, user_a, JobKind.CHECKIN_MONTHLY)
    assert worker_for(empty_queue, {}).run_once() is True
    assert job(empty_queue, job_id)["last_error"] == (
        "UnknownJobKind: no handler for job kind checkin.monthly"
    )


def test_idle_worker_reports_no_work(empty_queue: Connection) -> None:
    assert worker_for(empty_queue, {}).run_once() is False


def test_system_jobs_have_no_user_session(empty_queue: Connection) -> None:
    def handler(ctx: JobContext) -> dict[str, Any]:
        with pytest.raises(RuntimeError, match="system job"):
            ctx.user_session()
        return {"system": True}

    empty_queue.execute(text("INSERT INTO jobs (kind) VALUES ('schedule.tick')"))
    assert worker_for(empty_queue, {JobKind.SCHEDULE_TICK: handler}).run_once() is True
    assert empty_queue.execute(
        text("SELECT result FROM jobs WHERE kind = 'schedule.tick' AND status = 'succeeded'")
    ).scalar_one() == {"system": True}


def test_default_handlers_cover_the_m1_kinds() -> None:
    assert set(default_handlers()) >= {
        JobKind.SYNC_INITIAL,
        JobKind.SYNC_INCREMENTAL,
        JobKind.RECURRING_DETECT,
        JobKind.SCHEDULE_TICK,
    }


def test_recurring_detect_is_a_recorded_no_op(empty_queue: Connection, user_a: FixtureUser) -> None:
    job_id = enqueue(empty_queue, user_a, JobKind.RECURRING_DETECT)
    worker_for(empty_queue, default_handlers()).run_once()
    assert job(empty_queue, job_id)["result"] == {"status": "not_implemented", "detected": 0}


# ---------------------------------------------------------------- real engine


@pytest.fixture
def scratch_engine(scratch_database: tuple[str, Engine]) -> Engine:
    url, engine = scratch_database
    upgrade(url, "head")
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
            {"id": USER_A.id, "email": USER_A.email},
        )
    return engine


def test_heartbeats_while_a_handler_runs(scratch_engine: Engine) -> None:
    with scratch_engine.begin() as connection:
        job_id = connection.execute(
            text("INSERT INTO jobs (user_id, kind) VALUES (:u, 'categorize.run') RETURNING id"),
            {"u": USER_A.id},
        ).scalar_one()

    def slow(ctx: JobContext) -> dict[str, Any]:
        time.sleep(0.4)
        return {}

    worker = Worker(
        handlers={JobKind.CATEGORIZE_RUN: slow},
        services=Services(),
        queue_bind=scratch_engine,
        user_bind=scratch_engine,
        heartbeat_seconds=0.05,
    )
    beats: list[int] = []
    original = queue.heartbeat

    def counting(job_id: uuid.UUID, *, bind: Engine | Connection | None = None) -> None:
        beats.append(1)
        original(job_id, bind=bind)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(queue, "heartbeat", counting)
        assert worker.run_once()
    assert len(beats) >= 3
    with scratch_engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT status FROM jobs WHERE id = :id"), {"id": job_id}
            ).scalar_one()
            == "succeeded"
        )


def test_run_loop_stops_on_request(scratch_engine: Engine) -> None:
    stop = threading.Event()
    worker = Worker(
        handlers=default_handlers(),
        services=Services(),
        queue_bind=scratch_engine,
        user_bind=scratch_engine,
    )
    runner = threading.Thread(target=worker.run, args=(stop,), kwargs={"poll_seconds": 0.05})
    runner.start()
    time.sleep(0.3)
    stop.set()
    runner.join(timeout=5)
    assert not runner.is_alive()
    with scratch_engine.connect() as connection:
        # Startup queued the scheduler's tick chain.
        assert (
            connection.execute(
                text("SELECT count(*) FROM jobs WHERE kind = 'schedule.tick'")
            ).scalar_one()
            >= 1
        )


def test_worker_process_exits_cleanly_on_sigterm(scratch_database: tuple[str, Engine]) -> None:
    url, _ = scratch_database
    upgrade(url, "head")
    env = {**os.environ, "DATABASE_URL": url, "DATABASE_URL_PRIVILEGED": url}
    process = subprocess.Popen(
        [sys.executable, "-m", "jobs.worker"],
        cwd=REPO_ROOT / "api",
        env=env,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stderr is not None
        deadline = time.monotonic() + 15
        line = ""
        while "worker started" not in line and time.monotonic() < deadline:
            line = process.stderr.readline()
        assert "worker started" in line
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=15) == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        if process.stderr is not None:
            process.stderr.close()
