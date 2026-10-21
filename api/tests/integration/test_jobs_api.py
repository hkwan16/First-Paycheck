"""GET /jobs/{id} (spec 002)."""

from __future__ import annotations

import uuid
from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from db.enums import JobKind
from jobs import queue
from tests.conftest import FixtureUser
from tests.support.factories import make_job

Client = Callable[[FixtureUser], TestClient]


def test_get_own_job(db_connection: Connection, client_as: Client, user_a: FixtureUser) -> None:
    job = make_job(
        db_connection, user_a.id, kind=JobKind.SYNC_INITIAL, payload={"sync_item_id": "x"}
    )
    response = client_as(user_a).get(f"/jobs/{job}")
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "id": str(job),
        "kind": "sync.initial",
        "status": "queued",
        "progress": 0,
        "result": None,
        "last_error": None,
        "created_at": body["created_at"],
        "finished_at": None,
    }


def test_finished_job_shows_its_result(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    db_connection.execute(text("DELETE FROM jobs"))
    job = make_job(db_connection, user_a.id, kind=JobKind.RECURRING_DETECT)
    claimed = queue.dequeue(bind=db_connection)
    assert claimed is not None
    queue.complete(claimed, {"status": "not_implemented", "detected": 0}, bind=db_connection)
    body = client_as(user_a).get(f"/jobs/{job}").json()
    assert (body["status"], body["progress"], body["result"]) == (
        "succeeded",
        100,
        {"status": "not_implemented", "detected": 0},
    )
    assert body["finished_at"] is not None


def test_unknown_and_system_jobs_are_404(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    tick = db_connection.execute(
        text("INSERT INTO jobs (kind) VALUES ('schedule.tick') RETURNING id")
    ).scalar_one()
    client = client_as(user_a)
    assert client.get(f"/jobs/{tick}").status_code == 404
    assert client.get(f"/jobs/{uuid.uuid4()}").status_code == 404
    assert client.get("/jobs/not-a-uuid").status_code == 422
