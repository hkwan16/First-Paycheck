"""Replacing a document: the new upload retires the one it names (spec 004
rules 24-31, hand-worked examples "Replace"). The cross-user case is in
``tests/rls/test_cross_user.py``."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx2 import Response
from sqlalchemy import Connection, text

from ingest import store
from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from llm.gateway import Content, Reply
from llm.prompts import Prompt
from tests.conftest import FixtureUser
from tests.integration.test_docs_flow import CONFIRMED, PLAN, STUB_PDF, blob_count
from tests.support.documents import text_pdf
from tests.support.factories import make_document
from tests.support.spy_gateway import SpyGateway

Client = Callable[[FixtureUser], TestClient]

BENEFITS_PDF = text_pdf([["Bronze HSA (high deductible)", "Gold PPO", "401(k) match"]])
TIERS = [{"employee_pct_upto": "6.00", "employer_pct": "50.00"}]


@pytest.fixture
def queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def upload(
    client: TestClient,
    data: bytes = STUB_PDF,
    *,
    type: str = "pay_stub",
    replaces: object = None,
    filename: str = "stub.pdf",
    content_type: str = "application/pdf",
) -> Response:
    form = {"type": type}
    if replaces is not None:
        form["replaces"] = str(replaces)
    return client.post("/docs", data=form, files={"file": (filename, data, content_type)})


def uploaded(client: TestClient, data: bytes = STUB_PDF, **kwargs: Any) -> str:
    response = upload(client, data, **kwargs)
    assert response.status_code == 201, response.text
    return str(response.json()["document_id"])


def run_job(connection: Connection, extractor: SpyGateway | None) -> dict[str, Any]:
    """Run the one queued job and return its result."""
    job_id = connection.execute(text("SELECT id FROM jobs WHERE status = 'queued'")).scalar_one()
    worker = Worker(
        handlers=default_handlers(),
        services=Services(extractor=extractor),
        queue_bind=connection,
        user_bind=connection,
    )
    assert worker.run_once()
    status, result = connection.execute(
        text("SELECT status::text, result FROM jobs WHERE id = :id"), {"id": job_id}
    ).one()
    assert status == "succeeded"
    return dict(result)


def read(client: TestClient, connection: Connection, document_id: str, **gateway: Any) -> None:
    """Extract the document with the fake model (or none) and run the job."""
    assert client.post(f"/docs/{document_id}/extract").status_code == 202
    extractor = None if gateway.pop("no_model", False) else SpyGateway(connection, **gateway)
    run_job(connection, extractor)


def row(connection: Connection, document_id: str) -> Any:
    return connection.execute(
        text(
            "SELECT status::text AS status, status_reason::text AS reason, replaced_by_id,"
            " deleted_at, confirmed_at, proposal FROM documents WHERE id = :id"
        ),
        {"id": document_id},
    ).one()


def listed(client: TestClient) -> list[str]:
    return [d["id"] for d in client.get("/docs").json()]


def document_count(connection: Connection) -> int:
    return int(connection.execute(text("SELECT count(*) FROM documents")).scalar_one())


# Example 1: the October 29 alpha, a manual-entry stub replaced -----------------------


def test_replacing_a_manual_entry_stub_retires_it(
    queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    old = uploaded(client)
    read(client, queue, old, no_model=True)
    assert (row(queue, old).status, row(queue, old).reason) == ("manual_entry_required", "no_model")

    new = uploaded(client, replaces=old)

    assert listed(client) == [new]
    retired = row(queue, old)
    assert (retired.status, retired.reason) == ("manual_entry_required", "no_model")
    assert retired.replaced_by_id == uuid.UUID(new)
    assert retired.deleted_at is not None
    assert retired.proposal is None
    assert blob_count(queue, old) == 0
    assert blob_count(queue, new) == 1

    detail = client.get(f"/docs/{old}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["replaced_by_id"] == new
    assert detail.json()["proposal"] is None
    fresh = client.get(f"/docs/{new}").json()
    assert (fresh["status"], fresh["replaced_by_id"]) == ("uploaded", None)


# Examples 2 and 3: what was confirmed stays -----------------------------------------


def test_replacing_a_confirmed_stub_keeps_its_pay_stub(
    queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    old = uploaded(client)
    read(client, queue, old)
    confirmed = client.post(f"/docs/{old}/confirm", json={"pay_stub": CONFIRMED})
    assert confirmed.status_code == 200, confirmed.text
    confirmed_at = row(queue, old).confirmed_at

    new = uploaded(client, replaces=old)

    assert listed(client) == [new]
    retired = row(queue, old)
    assert (retired.status, retired.replaced_by_id) == ("confirmed", uuid.UUID(new))
    assert retired.deleted_at == confirmed_at
    stubs = client.get("/pay-stubs").json()
    assert [(s["document_id"], s["net_cents"]) for s in stubs] == [(old, 199_604)]


def test_replacing_a_confirmed_summary_keeps_its_plans_chunks_and_match(
    queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    old = uploaded(client, BENEFITS_PDF, type="benefits")
    read(client, queue, old)
    body = {"plans": [PLAN], "retirement": {"match_tiers": TIERS, "vesting_years": 3}}
    confirmed = client.post(f"/docs/{old}/confirm", json={"benefits": body})
    assert confirmed.status_code == 200, confirmed.text
    plans = client.get("/benefits-plans").json()
    profile = client.get("/profile").json()
    chunks = queue.execute(
        text("SELECT count(*) FROM benefits_chunks WHERE document_id = :id"), {"id": old}
    ).scalar_one()
    assert chunks > 0

    new = uploaded(client, BENEFITS_PDF, type="benefits", replaces=old)

    assert listed(client) == [new]
    assert client.get("/benefits-plans").json() == plans
    assert client.get("/profile").json() == profile
    assert (profile["match_tiers"], profile["vesting_years"]) == (TIERS, 3)
    still = queue.execute(
        text("SELECT count(*) FROM benefits_chunks WHERE document_id = :id"), {"id": old}
    ).scalar_one()
    assert still == chunks


# Examples 4 and 5: a document still being read ---------------------------------------


def test_a_job_queued_for_a_replaced_document_is_skipped(
    queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    old = uploaded(client)
    assert client.post(f"/docs/{old}/extract").status_code == 202

    new = uploaded(client, replaces=old)
    gateway = SpyGateway(queue)
    result = run_job(queue, gateway)

    assert result == {"status": "skipped"}
    assert gateway.contents == []
    retired = row(queue, old)
    assert (retired.status, retired.replaced_by_id, retired.proposal) == (
        "extracting",
        uuid.UUID(new),
        None,
    )
    assert listed(client) == [new]


class ReplacingGateway(SpyGateway):
    """Replaces the document while the model is reading it."""

    def __init__(self, connection: Connection, replace: Callable[[], None]) -> None:
        super().__init__(connection)
        self._replace = replace

    def _send(self, prompt: Prompt, model: str, content: Content) -> Reply:
        self._replace()
        return super()._send(prompt, model, content)


def test_a_job_reading_a_document_replaced_meanwhile_writes_nothing(
    queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    old = uploaded(client)
    assert client.post(f"/docs/{old}/extract").status_code == 202
    replacements: list[str] = []

    result = run_job(
        queue, ReplacingGateway(queue, lambda: replacements.append(uploaded(client, replaces=old)))
    )

    assert result == {"status": "skipped"}
    retired = row(queue, old)
    assert (retired.status, retired.proposal) == ("extracting", None)
    assert retired.replaced_by_id == uuid.UUID(replacements[0])


# Example 6: a retired document is final ----------------------------------------------


def test_a_replaced_document_cannot_be_read_or_confirmed(
    queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    old = uploaded(client)
    read(client, queue, old)
    uploaded(client, replaces=old)

    confirm = client.post(f"/docs/{old}/confirm", json={"pay_stub": CONFIRMED})
    assert confirm.status_code == 409
    assert confirm.json()["error"]["code"] == "document_replaced"
    extract = client.post(f"/docs/{old}/extract")
    assert extract.status_code == 409
    assert extract.json()["error"]["code"] == "document_replaced"
    assert queue.execute(text("SELECT count(*) FROM pay_stubs")).scalar_one() == 0
    queued = queue.execute(text("SELECT count(*) FROM jobs WHERE status = 'queued'"))
    assert queued.scalar_one() == 0


def test_a_replaced_confirmed_document_says_replaced_first(
    queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    old = uploaded(client)
    read(client, queue, old)
    assert client.post(f"/docs/{old}/confirm", json={"pay_stub": CONFIRMED}).status_code == 200
    uploaded(client, replaces=old)
    again = client.post(f"/docs/{old}/confirm", json={"pay_stub": CONFIRMED})
    assert (again.status_code, again.json()["error"]["code"]) == (409, "document_replaced")


# Examples 7-10 and a malformed id: refusals leave everything as it was ----------------


def untouched(connection: Connection, client: TestClient, document_id: str) -> None:
    assert listed(client) == [document_id]
    assert document_count(connection) == 1
    assert row(connection, document_id).replaced_by_id is None
    assert row(connection, document_id).deleted_at is None
    assert blob_count(connection, document_id) == 1


def test_replacing_with_another_type_is_422(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    old = uploaded(client, BENEFITS_PDF, type="benefits")
    response = upload(client, replaces=old)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "replace_type_mismatch"
    untouched(db_connection, client, old)


def test_replacing_twice_is_409(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    old = uploaded(client)
    new = uploaded(client, replaces=old)
    again = upload(client, replaces=old)
    assert again.status_code == 409, again.text
    assert again.json()["error"]["code"] == "document_replaced"
    assert document_count(db_connection) == 2
    assert listed(client) == [new]


@pytest.mark.parametrize(
    ("data", "content_type", "status"),
    [
        (b"GIF89a....", "image/gif", 415),
        (b"", "application/pdf", 422),
        (b"%PDF-" + b"0" * (10 * 1024 * 1024), "application/pdf", 413),
    ],
    ids=["unsupported", "empty", "too_large"],
)
def test_a_refused_replacement_leaves_the_document(
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    data: bytes,
    content_type: str,
    status: int,
) -> None:
    client = client_as(user_a)
    old = uploaded(client)
    response = upload(client, data, content_type=content_type, replaces=old)
    assert response.status_code == status, response.text
    untouched(db_connection, client, old)


def test_replacing_an_unknown_document_is_404(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    response = upload(client, replaces=uuid.uuid4())
    assert response.status_code == 404, response.text
    assert response.json()["error"]["code"] == "not_found"
    assert document_count(db_connection) == 0


def test_replaces_must_be_an_id(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    old = uploaded(client)
    assert upload(client, replaces="not-an-id").status_code == 422
    untouched(db_connection, client, old)


# Rule 30: any status, including failed and expired ------------------------------------


@pytest.mark.parametrize(
    "fields",
    [
        {"status": "failed", "status_reason": "unreadable_file"},
        {
            "status": "failed",
            "status_reason": "expired",
            "deleted_at": dt.datetime(2026, 10, 1, tzinfo=dt.UTC),
        },
        {"status": "proposed", "proposal": {"fields": []}},
    ],
    ids=["unreadable", "expired", "proposed"],
)
def test_any_status_can_be_replaced(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, fields: dict[str, Any]
) -> None:
    expired = "deleted_at" in fields
    old = str(make_document(db_connection, user_a.id, with_blob=not expired, **fields))
    client = client_as(user_a)
    new = uploaded(client, replaces=old)
    assert listed(client) == [new]
    retired = row(db_connection, old)
    assert retired.replaced_by_id == uuid.UUID(new)
    assert retired.status == fields["status"]
    if expired:
        assert retired.deleted_at == fields["deleted_at"]


# Example 12: retention skips a retired document ---------------------------------------


def test_retention_leaves_a_replaced_document(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    now = dt.datetime.now(dt.UTC)
    old = str(make_document(db_connection, user_a.id, created_at=now - dt.timedelta(days=8)))
    new = uploaded(client_as(user_a), replaces=old)
    before = row(db_connection, old)

    assert store.expire_unconfirmed(db_connection, now=now) == 0

    after = row(db_connection, old)
    assert (after.status, after.deleted_at) == (before.status, before.deleted_at)
    assert row(db_connection, new).status == "uploaded"
