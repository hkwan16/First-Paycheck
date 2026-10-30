"""Reading a document again after the model was unavailable (spec 004 rules 32-37, issue 163)."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app import ratelimit
from app.db import user_session_for
from app.deps import get_now
from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from llm.gateway import Content
from tests.conftest import FixtureUser
from tests.support.documents import ACME_ACCOUNT, ACME_SSN, ACME_STUB_LINES, text_pdf
from tests.support.factories import make_document
from tests.support.spy_gateway import SpyGateway

Client = Callable[[FixtureUser], TestClient]

STUB_PDF = text_pdf([ACME_STUB_LINES])
NOW = dt.datetime(2026, 10, 30, 15, 20, tzinfo=dt.UTC)


@pytest.fixture
def frozen(app: FastAPI, db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    app.dependency_overrides[get_now] = lambda: NOW
    return db_connection


def run_worker(connection: Connection, extractor: SpyGateway | None) -> None:
    worker = Worker(
        handlers=default_handlers(),
        services=Services(extractor=extractor),
        queue_bind=connection,
        user_bind=connection,
    )
    assert worker.run_once()


def read_without_a_model(client: TestClient, connection: Connection) -> str:
    """Rule 32: the Acme stub uploaded and read by a worker with no gateway."""
    response = client.post(
        "/docs",
        data={"type": "pay_stub"},
        files={"file": ("stub.pdf", STUB_PDF, "application/pdf")},
    )
    assert response.status_code == 201, response.text
    document_id = str(response.json()["document_id"])
    assert client.post(f"/docs/{document_id}/extract").status_code == 202
    run_worker(connection, None)
    return document_id


def listed(client: TestClient, document_id: str) -> dict[str, Any]:
    [row] = [d for d in client.get("/docs").json() if d["id"] == document_id]
    return row


def job_count(connection: Connection) -> int:
    return int(connection.execute(text("SELECT count(*) FROM jobs")).scalar_one())


def sent_text(content: Content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(str(block.get("text", "")) for block in content)


def test_a_document_read_without_a_model_is_read_again(
    frozen: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Example 1."""
    client = client_as(user_a)
    document_id = read_without_a_model(client, frozen)
    row = listed(client, document_id)
    assert (row["status"], row["status_reason"], row["can_read_again"]) == (
        "manual_entry_required",
        "no_model",
        True,
    )

    again = client.post(f"/docs/{document_id}/extract")

    assert again.status_code == 202, again.text
    detail = client.get(f"/docs/{document_id}").json()
    assert (detail["status"], detail["status_reason"], detail["can_read_again"]) == (
        "extracting",
        None,
        False,
    )
    gateway = SpyGateway(frozen)
    run_worker(frozen, gateway)
    detail = client.get(f"/docs/{document_id}").json()
    assert (detail["status"], detail["status_reason"], detail["can_read_again"]) == (
        "proposed",
        None,
        False,
    )
    fields = {f["key"]: f["value"] for f in detail["proposal"]["fields"]}
    assert fields["gross_cents"] == 270_833
    # Rule 36: the reading starts from the stored bytes and redacts them again.
    (content,) = gateway.contents
    sent = sent_text(content)
    assert "[REDACTED]" in sent
    assert ACME_SSN not in sent
    assert ACME_ACCOUNT not in sent


@pytest.mark.parametrize("reason", ["budget", "extraction_failed"])
def test_other_unavailable_readings_can_be_read_again(
    frozen: Connection, client_as: Client, user_a: FixtureUser, reason: str
) -> None:
    """Examples 2 and 3."""
    document_id = make_document(
        frozen, user_a.id, data=STUB_PDF, status="manual_entry_required", status_reason=reason
    )
    client = client_as(user_a)
    assert listed(client, str(document_id))["can_read_again"] is True
    assert client.post(f"/docs/{document_id}/extract").status_code == 202
    assert client.get(f"/docs/{document_id}").json()["status"] == "extracting"


@pytest.mark.parametrize("reason", ["refused", "no_readable_page"])
def test_a_final_outcome_is_not_read_again(
    frozen: Connection, client_as: Client, user_a: FixtureUser, reason: str
) -> None:
    """Examples 4 and 5 (rule 35)."""
    document_id = make_document(
        frozen, user_a.id, data=STUB_PDF, status="manual_entry_required", status_reason=reason
    )
    client = client_as(user_a)
    assert listed(client, str(document_id))["can_read_again"] is False

    response = client.post(f"/docs/{document_id}/extract")

    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "document_already_read"
    assert job_count(frozen) == 0
    detail = client.get(f"/docs/{document_id}").json()
    assert (detail["status"], detail["status_reason"]) == ("manual_entry_required", reason)


def test_a_replaced_document_is_not_read_again(
    frozen: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Example 6."""
    client = client_as(user_a)
    document_id = read_without_a_model(client, frozen)
    replaced = client.post(
        "/docs",
        data={"type": "pay_stub", "replaces": document_id},
        files={"file": ("stub.pdf", STUB_PDF, "application/pdf")},
    )
    assert replaced.status_code == 201, replaced.text

    assert client.get(f"/docs/{document_id}").json()["can_read_again"] is False
    response = client.post(f"/docs/{document_id}/extract")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "document_replaced"


def test_reading_again_counts_against_the_extract_limit(
    frozen: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Example 7."""
    client = client_as(user_a)
    document_id = read_without_a_model(client, frozen)
    jobs = job_count(frozen)
    with user_session_for(user_a.id, bind=frozen) as session:
        # The first reading counted one.
        for _ in range(ratelimit.EXTRACTIONS.limit - 1):
            ratelimit.consume(session, user_a.id, ratelimit.EXTRACTIONS, now=NOW)

    response = client.post(f"/docs/{document_id}/extract")

    assert response.status_code == 429, response.text
    assert response.json()["error"]["code"] == "rate_limited"
    assert job_count(frozen) == jobs
    detail = client.get(f"/docs/{document_id}").json()
    assert (detail["status"], detail["status_reason"]) == ("manual_entry_required", "no_model")
