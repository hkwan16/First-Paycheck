"""sync.initial and sync.incremental run the pipeline as the job's user."""

from __future__ import annotations

import pytest
from sqlalchemy import Connection, text

from app.db import user_session_for
from db.enums import JobKind
from jobs import queue
from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from sync.pipeline import SyncItemSecrets
from sync.provider import SyncProvider
from tests.conftest import FixtureUser
from tests.support.factories import make_item
from tests.support.fake_provider import CHECKING, FakeProvider, page, txn


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def run_job(
    connection: Connection, user: FixtureUser, kind: JobKind, payload: dict[str, str]
) -> dict[str, object]:
    with user_session_for(user.id, bind=connection) as session:
        job_id = queue.enqueue(session, user_id=user.id, kind=kind, payload=payload)
    built: list[SyncItemSecrets] = []

    def provider_for(secrets: SyncItemSecrets) -> SyncProvider:
        built.append(secrets)
        return FakeProvider(accounts=[CHECKING], pages={None: page("c1", added=[txn("t1", 999)])})

    worker = Worker(
        handlers=default_handlers(),
        services=Services(provider_for=provider_for),
        queue_bind=connection,
        user_bind=connection,
    )
    assert worker.run_once()
    row = connection.execute(
        text("SELECT status, result, last_error FROM jobs WHERE id = :id"), {"id": job_id}
    ).one()
    return dict(row._mapping)


@pytest.mark.parametrize("kind", [JobKind.SYNC_INITIAL, JobKind.SYNC_INCREMENTAL])
def test_sync_jobs_run_the_pipeline(
    empty_queue: Connection, user_a: FixtureUser, kind: JobKind
) -> None:
    item = make_item(empty_queue, user_a.id)
    row = run_job(empty_queue, user_a, kind, {"sync_item_id": str(item)})
    assert row["status"] == "succeeded"
    assert row["result"] == {
        "outcome": "synced",
        "accounts": 1,
        "added": 1,
        "modified": 0,
        "removed": 0,
        "skipped": 0,
        "balances": 0,
        "holdings": 0,
    }
    kinds = empty_queue.execute(
        text("SELECT kind FROM jobs WHERE status = 'queued' ORDER BY kind")
    ).scalars()
    assert list(kinds) == ["categorize.run", "recurring.detect"]


def test_a_sync_job_for_another_users_item_finds_nothing(
    empty_queue: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    item = make_item(empty_queue, user_a.id)
    row = run_job(empty_queue, user_b, JobKind.SYNC_INCREMENTAL, {"sync_item_id": str(item)})
    assert row["result"] == {
        "outcome": "item_missing",
        "accounts": 0,
        "added": 0,
        "modified": 0,
        "removed": 0,
        "skipped": 0,
        "balances": 0,
        "holdings": 0,
    }


def test_a_malformed_payload_fails_the_job(empty_queue: Connection, user_a: FixtureUser) -> None:
    row = run_job(empty_queue, user_a, JobKind.SYNC_INCREMENTAL, {"sync_item_id": "nope"})
    assert row["status"] == "queued"
    assert str(row["last_error"]).startswith("ValueError: sync_item_id")


def test_without_a_provider_the_job_fails_clearly(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    item = make_item(empty_queue, user_a.id)
    with user_session_for(user_a.id, bind=empty_queue) as session:
        job_id = queue.enqueue(
            session,
            user_id=user_a.id,
            kind=JobKind.SYNC_INCREMENTAL,
            payload={"sync_item_id": str(item)},
        )
    Worker(services=Services(), queue_bind=empty_queue, user_bind=empty_queue).run_once()
    error = empty_queue.execute(
        text("SELECT last_error FROM jobs WHERE id = :id"), {"id": job_id}
    ).scalar_one()
    assert error == "RuntimeError: no sync provider is configured for this worker"
