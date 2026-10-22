"""The ``ingest.extract`` job (spec 005 rules 10-15)."""

from __future__ import annotations

import base64
import io
import re
import uuid
from typing import Any

import pytest
from PIL import Image
from sqlalchemy import Connection, text, update

from app.db import user_session_for
from db.enums import DocumentStatus, JobKind
from db.models import Document
from ingest import store
from ingest.ocr import ocr_image
from jobs import queue
from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from llm.gateway import Content, Gateway, LLMUnavailable, Reply, Usage
from tests.conftest import FixtureUser
from tests.support.anthropic_api import ErroringApi, api_gateway
from tests.support.documents import (
    ACME_ACCOUNT,
    ACME_SSN,
    ACME_STUB_LINES,
    encode,
    noise_page,
    render_page,
    text_pdf,
)
from tests.support.factories import make_document
from tests.support.spy_gateway import SpyGateway

STUB_PDF = text_pdf([ACME_STUB_LINES])


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def queue_extract(connection: Connection, user: FixtureUser, document_id: uuid.UUID) -> uuid.UUID:
    """What ``POST /docs/{id}/extract`` does: queue the job and mark the document."""
    with user_session_for(user.id, bind=connection) as session:
        job_id = queue.enqueue(
            session,
            user_id=user.id,
            kind=JobKind.INGEST_EXTRACT,
            payload={"document_id": str(document_id)},
        )
        session.execute(
            update(Document)
            .where(Document.id == document_id)
            .values(status=DocumentStatus.EXTRACTING, extract_job_id=job_id)
        )
    return job_id


def run_worker(connection: Connection, gateway: Gateway | None) -> None:
    worker = Worker(
        handlers=default_handlers(),
        services=Services(extractor=gateway),
        queue_bind=connection,
        user_bind=connection,
    )
    assert worker.run_once()


def job_row(connection: Connection, job_id: uuid.UUID) -> dict[str, Any]:
    row = connection.execute(
        text("SELECT status::text, result, last_error, attempts FROM jobs WHERE id = :id"),
        {"id": job_id},
    ).one()
    return dict(row._mapping)


def document_row(connection: Connection, document_id: uuid.UUID) -> dict[str, Any]:
    row = connection.execute(
        text(
            "SELECT status::text, status_reason::text, proposal, redaction_count, page_count"
            " FROM documents WHERE id = :id"
        ),
        {"id": document_id},
    ).one()
    return dict(row._mapping)


def sent_text(content: Content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(str(block.get("text", "")) for block in content)


def sent_images(content: Content) -> list[Image.Image]:
    assert not isinstance(content, str)
    images: list[Image.Image] = []
    for block in content:
        if block["type"] != "image":
            continue
        source = block["source"]
        assert source["type"] == "base64"
        data = source["data"]
        assert isinstance(data, str)
        images.append(Image.open(io.BytesIO(base64.b64decode(data))))
    return images


def fields(proposal: dict[str, Any]) -> dict[str, Any]:
    return {field["key"]: field["value"] for field in proposal["fields"]}


# Proposed ------------------------------------------------------------------------


def test_text_pdf_is_proposed_from_redacted_text(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    job_id = queue_extract(empty_queue, user_a, document)
    gateway = SpyGateway(empty_queue)
    run_worker(empty_queue, gateway)

    job = job_row(empty_queue, job_id)
    assert job["status"] == "succeeded"
    assert job["result"] == {
        "document_id": str(document),
        "status": "proposed",
        "page_count": 1,
        "redaction_count": 2,
        "withheld_pages": [],
    }
    row = document_row(empty_queue, document)
    assert (row["status"], row["status_reason"]) == ("proposed", None)
    assert (row["redaction_count"], row["page_count"]) == (2, 1)
    proposal = row["proposal"]
    assert fields(proposal)["gross_cents"] == 270_833
    assert fields(proposal)["other_deductions_cents"] == 4_670
    assert [line["text"] for line in proposal["source_lines"] if line["redacted"]] == [
        "SSN [REDACTED]",
        "Direct Deposit Acct [REDACTED]",
    ]
    # The proposal and the model input never hold the SSN or the account number.
    assert ACME_SSN not in str(proposal)
    assert ACME_ACCOUNT not in str(proposal)
    (content,) = gateway.contents
    sent = sent_text(content)
    assert "Gross Pay 2,708.33" in sent
    assert "[REDACTED]" in sent
    assert ACME_SSN not in sent
    assert ACME_ACCOUNT not in sent


def test_the_llm_call_is_tied_to_the_job(empty_queue: Connection, user_a: FixtureUser) -> None:
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    job_id = queue_extract(empty_queue, user_a, document)
    run_worker(empty_queue, SpyGateway(empty_queue))
    purpose, logged_job = empty_queue.execute(
        text("SELECT purpose::text, job_id FROM llm_calls WHERE user_id = :u"), {"u": user_a.id}
    ).one()
    assert (purpose, logged_job) == ("extract", job_id)


def test_scanned_image_reaches_the_model_redacted(
    tesseract: None, empty_queue: Connection, user_a: FixtureUser
) -> None:
    png = encode(render_page(ACME_STUB_LINES))
    document = make_document(empty_queue, user_a.id, data=png, content_type="image/png")
    queue_extract(empty_queue, user_a, document)
    gateway = SpyGateway(empty_queue)
    run_worker(empty_queue, gateway)

    row = document_row(empty_queue, document)
    assert row["status"] == "proposed"
    assert row["redaction_count"] >= 2
    (content,) = gateway.contents
    (image,) = sent_images(content)
    reread = "\n".join(line.text for line in ocr_image(image).lines)
    assert "Gross" in reread
    assert ACME_SSN not in reread
    assert ACME_ACCOUNT not in reread
    assert not re.search(r"\d{9}", reread.replace("-", "").replace(" ", ""))
    assert ACME_SSN not in sent_text(content)


def test_benefits_document_proposes_plans(empty_queue: Connection, user_a: FixtureUser) -> None:
    pdf = text_pdf([["Bronze HSA (high deductible)", "Gold PPO", "Enroll by November 15, 2026"]])
    document = make_document(empty_queue, user_a.id, type="benefits", data=pdf)
    queue_extract(empty_queue, user_a, document)
    run_worker(empty_queue, SpyGateway(empty_queue))
    proposal = document_row(empty_queue, document)["proposal"]
    assert proposal["fields"] == []
    assert [fields(plan)["name"] for plan in proposal["plans"]] == ["Bronze HSA", "Gold PPO"]


# Manual entry and failure ----------------------------------------------------------


def test_refusal_means_manual_entry(empty_queue: Connection, user_a: FixtureUser) -> None:
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    job_id = queue_extract(empty_queue, user_a, document)
    refusal = Reply(stop_reason="refusal", text=None, usage=Usage())
    run_worker(empty_queue, SpyGateway(empty_queue, reply=refusal))

    assert job_row(empty_queue, job_id)["status"] == "succeeded"
    assert job_row(empty_queue, job_id)["result"]["status"] == "manual_entry_required"
    row = document_row(empty_queue, document)
    assert (row["status"], row["status_reason"]) == ("manual_entry_required", "refused")
    assert (row["redaction_count"], row["page_count"]) == (2, 1)
    assert all(field["value"] is None for field in row["proposal"]["fields"])
    assert len(row["proposal"]["source_lines"]) == len(ACME_STUB_LINES)


def test_spent_budget_means_manual_entry_without_a_call(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    queue_extract(empty_queue, user_a, document)
    gateway = SpyGateway(empty_queue, llm_daily_budget_cents=0)
    run_worker(empty_queue, gateway)
    assert gateway.contents == []
    row = document_row(empty_queue, document)
    assert (row["status"], row["status_reason"]) == ("manual_entry_required", "budget")


def test_no_readable_page_means_manual_entry(
    tesseract: None, empty_queue: Connection, user_a: FixtureUser
) -> None:
    document = make_document(
        empty_queue, user_a.id, data=encode(noise_page()), content_type="image/png"
    )
    job_id = queue_extract(empty_queue, user_a, document)
    gateway = SpyGateway(empty_queue)
    run_worker(empty_queue, gateway)
    assert gateway.contents == []
    row = document_row(empty_queue, document)
    assert (row["status"], row["status_reason"]) == ("manual_entry_required", "no_readable_page")
    assert row["proposal"]["withheld_pages"] == [1]
    assert job_row(empty_queue, job_id)["result"]["withheld_pages"] == [1]


def test_unreadable_file_fails_without_retrying(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    document = make_document(empty_queue, user_a.id, data=b"%PDF-1.4\nnot really a pdf\n")
    job_id = queue_extract(empty_queue, user_a, document)
    gateway = SpyGateway(empty_queue)
    run_worker(empty_queue, gateway)
    assert job_row(empty_queue, job_id)["status"] == "succeeded"
    row = document_row(empty_queue, document)
    assert (row["status"], row["status_reason"]) == ("failed", "unreadable_file")
    assert gateway.contents == []


@pytest.mark.parametrize(
    ("reply", "error"),
    [
        (Reply(stop_reason="end_turn", text="{}", usage=Usage()), None),
        (None, LLMUnavailable("overloaded")),
    ],
    ids=["schema_error", "api_error"],
)
def test_model_errors_retry_then_fall_back_to_manual_entry(
    empty_queue: Connection,
    user_a: FixtureUser,
    reply: Reply | None,
    error: Exception | None,
) -> None:
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    job_id = queue_extract(empty_queue, user_a, document)
    run_worker(empty_queue, SpyGateway(empty_queue, reply=reply, error=error))

    job = job_row(empty_queue, job_id)
    assert (job["status"], job["attempts"]) == ("queued", 1)
    assert job["last_error"]
    assert document_row(empty_queue, document)["status"] == "extracting"

    # Fast-forward to the fifth and last attempt.
    empty_queue.execute(
        text("UPDATE jobs SET attempts = 4, run_after = now() WHERE id = :id"), {"id": job_id}
    )
    run_worker(empty_queue, SpyGateway(empty_queue, reply=reply, error=error))
    assert job_row(empty_queue, job_id)["status"] == "succeeded"
    row = document_row(empty_queue, document)
    assert (row["status"], row["status_reason"]) == ("manual_entry_required", "extraction_failed")


def test_missing_blob_is_skipped(empty_queue: Connection, user_a: FixtureUser) -> None:
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    job_id = queue_extract(empty_queue, user_a, document)
    with user_session_for(user_a.id, bind=empty_queue) as session:
        store.delete(session, document)
    gateway = SpyGateway(empty_queue)
    run_worker(empty_queue, gateway)
    assert job_row(empty_queue, job_id)["result"] == {"status": "skipped"}
    assert gateway.contents == []


def test_a_superseded_job_changes_nothing(empty_queue: Connection, user_a: FixtureUser) -> None:
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    stale = queue_extract(empty_queue, user_a, document)
    # The user asked again; the document now belongs to a newer job.
    newer = queue_extract(empty_queue, user_a, document)
    empty_queue.execute(
        text("UPDATE jobs SET run_after = now() + interval '1 hour' WHERE id = :id"),
        {"id": newer},
    )
    gateway = SpyGateway(empty_queue)
    run_worker(empty_queue, gateway)
    assert job_row(empty_queue, stale)["result"] == {"status": "skipped"}
    assert gateway.contents == []
    assert document_row(empty_queue, document)["status"] == "extracting"


def test_user_b_cannot_extract_user_a_document(
    empty_queue: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    """A job whose payload names another user's document sees nothing (RLS)."""
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    with user_session_for(user_b.id, bind=empty_queue) as session:
        job_id = queue.enqueue(
            session,
            user_id=user_b.id,
            kind=JobKind.INGEST_EXTRACT,
            payload={"document_id": str(document)},
        )
    gateway = SpyGateway(empty_queue)
    run_worker(empty_queue, gateway)
    assert job_row(empty_queue, job_id)["result"] == {"status": "skipped"}
    assert gateway.contents == []
    assert document_row(empty_queue, document)["status"] == "uploaded"


def test_without_a_model_the_document_goes_to_manual_entry(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    """No ANTHROPIC_API_KEY (spec 004 rule 22): the user types the fields in by hand."""
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    job_id = queue_extract(empty_queue, user_a, document)
    run_worker(empty_queue, None)

    assert job_row(empty_queue, job_id)["status"] == "succeeded"
    row = document_row(empty_queue, document)
    assert (row["status"], row["status_reason"]) == ("manual_entry_required", "no_model")
    assert row["proposal"]["fields"]
    assert all(field["value"] is None for field in row["proposal"]["fields"])
    assert row["redaction_count"] >= 1


def llm_call_statuses(connection: Connection, user: FixtureUser) -> list[str]:
    rows = connection.execute(
        text("SELECT status::text FROM llm_calls WHERE user_id = :u ORDER BY created_at"),
        {"u": user.id},
    )
    return [status for (status,) in rows]


@pytest.mark.parametrize("status", [401, 403, 404])
def test_a_rejected_key_or_model_goes_to_manual_entry_at_once(
    empty_queue: Connection, user_a: FixtureUser, status: int
) -> None:
    """The API rejects the key (401), its permissions (403) or the model id (404).

    Retrying cannot fix configuration, so the first attempt hands the document
    to the user exactly as a worker with no model does (spec 005 rule 12),
    instead of leaving it ``extracting`` through half an hour of backoff.
    """
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    job_id = queue_extract(empty_queue, user_a, document)
    api = ErroringApi(status)
    run_worker(empty_queue, api_gateway(empty_queue, api))

    job = job_row(empty_queue, job_id)
    assert (job["status"], job["attempts"], job["last_error"]) == ("succeeded", 1, None)
    assert job["result"]["status"] == "manual_entry_required"
    row = document_row(empty_queue, document)
    assert (row["status"], row["status_reason"]) == ("manual_entry_required", "no_model")
    assert (row["redaction_count"], row["page_count"]) == (2, 1)
    assert all(field["value"] is None for field in row["proposal"]["fields"])
    assert len(row["proposal"]["source_lines"]) == len(ACME_STUB_LINES)
    # One request, and the failed call is still on the ledger.
    assert api.requests == 1
    assert llm_call_statuses(empty_queue, user_a) == ["api_error"]


@pytest.mark.parametrize("status", [429, 500, 529])
def test_a_transient_api_error_still_retries(
    empty_queue: Connection, user_a: FixtureUser, status: int
) -> None:
    document = make_document(empty_queue, user_a.id, data=STUB_PDF)
    job_id = queue_extract(empty_queue, user_a, document)
    run_worker(empty_queue, api_gateway(empty_queue, ErroringApi(status)))

    job = job_row(empty_queue, job_id)
    assert (job["status"], job["attempts"]) == ("queued", 1)
    assert "LLMUnavailable" in job["last_error"]
    assert document_row(empty_queue, document)["status"] == "extracting"
    assert llm_call_statuses(empty_queue, user_a) == ["api_error"]
