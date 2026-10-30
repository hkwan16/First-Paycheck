"""Upload, extract, review and confirm a document (specs 004 and 005)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx2 import Response
from sqlalchemy import Connection, text

from app.deps import get_now
from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from llm.gateway import Reply, Usage
from tests.conftest import FixtureUser
from tests.support.documents import ACME_ACCOUNT, ACME_SSN, ACME_STUB_LINES, text_pdf
from tests.support.factories import make_document
from tests.support.spy_gateway import SpyGateway

Client = Callable[[FixtureUser], TestClient]

STUB_PDF = text_pdf([ACME_STUB_LINES])
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
MAX_BYTES = 10 * 1024 * 1024

# What the review screen sends back for the Acme stub after the user checks it.
CONFIRMED: dict[str, Any] = {
    "employer_name": "Acme Corp",
    "pay_frequency": "semimonthly",
    "pay_date": "2026-10-15",
    "period_start": "2026-10-01",
    "period_end": "2026-10-15",
    "gross_cents": 270_833,
    "federal_withholding_cents": 29_776,
    "social_security_cents": 16_792,
    "medicare_cents": 3_927,
    "state_tax_cents": 9_814,
    "retirement_contribution_cents": 0,
    "medical_premium_cents": 6_250,
    "other_deductions_cents": 4_670,
    "net_cents": 199_604,
}
PLAN: dict[str, Any] = {
    "name": "Gold PPO",
    "kind": "ppo",
    "premium_per_period_cents": 6_250,
    "deductible_cents": 50_000,
    "oop_max_cents": 300_000,
    "coinsurance_pct": "10.00",
    "employer_hsa_cents": 0,
    "enrollment_deadline": "2026-11-15",
}


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def upload(
    client: TestClient,
    data: bytes = STUB_PDF,
    *,
    type: str = "pay_stub",
    filename: str = "stub.pdf",
    content_type: str = "application/pdf",
) -> Response:
    return client.post("/docs", data={"type": type}, files={"file": (filename, data, content_type)})


def uploaded(client: TestClient, data: bytes = STUB_PDF, **kwargs: Any) -> str:
    response = upload(client, data, **kwargs)
    assert response.status_code == 201, response.text
    return str(response.json()["document_id"])


def run_worker(connection: Connection, gateway: SpyGateway) -> None:
    worker = Worker(
        handlers=default_handlers(),
        services=Services(extractor=gateway),
        queue_bind=connection,
        user_bind=connection,
    )
    assert worker.run_once()


def extracted(client: TestClient, connection: Connection, document_id: str) -> dict[str, Any]:
    response = client.post(f"/docs/{document_id}/extract")
    assert response.status_code == 202, response.text
    run_worker(connection, SpyGateway(connection))
    detail = client.get(f"/docs/{document_id}")
    assert detail.status_code == 200, detail.text
    body: dict[str, Any] = detail.json()
    return body


def blob_count(connection: Connection, document_id: str) -> int:
    return int(
        connection.execute(
            text("SELECT count(*) FROM document_blobs WHERE document_id = :id"),
            {"id": document_id},
        ).scalar_one()
    )


# Upload ------------------------------------------------------------------------------


def test_the_whole_flow(empty_queue: Connection, client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    document_id = uploaded(client)
    listed = client.get("/docs").json()
    assert [(d["id"], d["type"], d["status"]) for d in listed] == [
        (document_id, "pay_stub", "uploaded")
    ]
    assert blob_count(empty_queue, document_id) == 1

    detail = extracted(client, empty_queue, document_id)
    assert detail["status"] == "proposed"
    assert (detail["redaction_count"], detail["page_count"]) == (2, 1)
    proposal = detail["proposal"]
    gross = next(f for f in proposal["fields"] if f["key"] == "gross_cents")
    assert gross == {
        "key": "gross_cents",
        "label": "Gross pay",
        "value": 270_833,
        "confidence": 0.99,
        "note": None,
        "kind": "money",
        "role": "gross",
    }
    assert ACME_SSN not in str(detail)
    assert ACME_ACCOUNT not in str(detail)
    assert any(line["redacted"] for line in proposal["source_lines"])

    confirmed = client.post(f"/docs/{document_id}/confirm", json={"pay_stub": CONFIRMED})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["document"]["status"] == "confirmed"
    assert blob_count(empty_queue, document_id) == 0
    status, deleted_at, confirmed_at = empty_queue.execute(
        text("SELECT status::text, deleted_at, confirmed_at FROM documents WHERE id = :id"),
        {"id": document_id},
    ).one()
    assert status == "confirmed"
    assert deleted_at is not None
    assert confirmed_at == deleted_at

    stubs = client.get("/pay-stubs").json()
    assert len(stubs) == 1
    assert stubs[0]["document_id"] == document_id
    assert stubs[0]["net_cents"] == 199_604
    assert stubs[0]["tax_year"] == 2026


def test_an_edited_field_stores_the_edited_value(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = uploaded(client)
    extracted(client, empty_queue, document_id)
    # The model found no 401(k) line; the user knows they put in $50.00 and
    # the stub's dental line was really part of it.
    edited = {**CONFIRMED, "retirement_contribution_cents": 5_000, "other_deductions_cents": 0}
    edited["net_cents"] = 199_604 - 5_000 + 4_670
    response = client.post(f"/docs/{document_id}/confirm", json={"pay_stub": edited})
    assert response.status_code == 200, response.text
    stub = response.json()["pay_stub"]
    assert stub["retirement_contribution_cents"] == 5_000
    assert stub["other_deductions_cents"] == 0
    stored = empty_queue.execute(
        text("SELECT retirement_contribution_cents, net_cents FROM pay_stubs")
    ).one()
    assert tuple(stored) == (5_000, 199_274)


def test_unbalanced_stub_is_422_with_the_difference(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = uploaded(client)
    extracted(client, empty_queue, document_id)
    response = client.post(
        f"/docs/{document_id}/confirm", json={"pay_stub": {**CONFIRMED, "net_cents": 199_606}}
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "pay_stub_unbalanced"
    assert error["details"] == {
        "gross_cents": 270_833,
        "deductions_cents": 71_229,
        "net_cents": 199_606,
        "expected_net_cents": 199_604,
        "difference_cents": -2,
    }
    # Nothing was stored and the blob is still there for another try.
    assert empty_queue.execute(text("SELECT count(*) FROM pay_stubs")).scalar_one() == 0
    assert blob_count(empty_queue, document_id) == 1
    assert client.get(f"/docs/{document_id}").json()["status"] == "proposed"


def test_confirm_twice_is_409(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = uploaded(client)
    extracted(client, empty_queue, document_id)
    assert (
        client.post(f"/docs/{document_id}/confirm", json={"pay_stub": CONFIRMED}).status_code == 200
    )
    again = client.post(f"/docs/{document_id}/confirm", json={"pay_stub": CONFIRMED})
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "document_confirmed"
    assert client.post(f"/docs/{document_id}/extract").status_code == 409


def test_confirm_before_extraction_is_409(client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    document_id = uploaded(client)
    response = client.post(f"/docs/{document_id}/confirm", json={"pay_stub": CONFIRMED})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "document_not_ready"


@pytest.mark.parametrize(
    "body",
    [
        {"benefits": {"plans": [PLAN]}},
        {},
        {"pay_stub": CONFIRMED, "benefits": {"plans": [PLAN]}},
        {"pay_stub": {**CONFIRMED, "gross_cents": "270833"}},
        {"pay_stub": {**CONFIRMED, "period_start": "2026-10-16"}},
    ],
    ids=["wrong_type", "empty", "both", "string_cents", "period_order"],
)
def test_confirm_rejects_bad_bodies(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser, body: dict[str, Any]
) -> None:
    client = client_as(user_a)
    document_id = uploaded(client)
    extracted(client, empty_queue, document_id)
    response = client.post(f"/docs/{document_id}/confirm", json=body)
    assert response.status_code == 422, response.text
    assert empty_queue.execute(text("SELECT count(*) FROM pay_stubs")).scalar_one() == 0


def test_manual_entry_can_be_confirmed(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = uploaded(client)
    assert client.post(f"/docs/{document_id}/extract").status_code == 202
    refusal = Reply(stop_reason="refusal", text=None, usage=Usage())
    run_worker(empty_queue, SpyGateway(empty_queue, reply=refusal))
    detail = client.get(f"/docs/{document_id}").json()
    assert (detail["status"], detail["status_reason"]) == ("manual_entry_required", "refused")
    assert len(detail["proposal"]["source_lines"]) == len(ACME_STUB_LINES)
    response = client.post(f"/docs/{document_id}/confirm", json={"pay_stub": CONFIRMED})
    assert response.status_code == 200, response.text


def test_benefits_confirm_writes_plans_and_chunks(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    words = [f"word{i}" for i in range(450)]
    pdf = text_pdf([["Bronze HSA (high deductible)", "Gold PPO", " ".join(words[:40])]])
    document_id = uploaded(client, pdf, type="benefits")
    detail = extracted(client, empty_queue, document_id)
    assert [len(plan["fields"]) for plan in detail["proposal"]["plans"]] == [8, 8]

    bronze = {**PLAN, "name": "Bronze HSA", "kind": "hdhp", "coinsurance_pct": "20"}
    response = client.post(
        f"/docs/{document_id}/confirm", json={"benefits": {"plans": [bronze, PLAN]}}
    )
    assert response.status_code == 200, response.text
    plans = response.json()["plans"]
    assert [(p["name"], p["coinsurance_pct"]) for p in plans] == [
        ("Bronze HSA", "20.00"),
        ("Gold PPO", "10.00"),
    ]
    chunks = empty_queue.execute(
        text(
            "SELECT chunk_index, text FROM benefits_chunks WHERE document_id = :id"
            " ORDER BY chunk_index"
        ),
        {"id": document_id},
    ).all()
    assert len(chunks) == 1
    assert chunks[0].text.startswith("Bronze HSA (high deductible) Gold PPO word0")
    found = empty_queue.execute(
        text("SELECT count(*) FROM benefits_chunks WHERE search @@ to_tsquery('english', 'ppo')")
    ).scalar_one()
    assert found == 1


def test_unbalanced_benefits_plan_is_422(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = uploaded(client, text_pdf([["Gold PPO plan summary page"]]), type="benefits")
    extracted(client, empty_queue, document_id)
    bad = {**PLAN, "deductible_cents": 400_000}
    response = client.post(f"/docs/{document_id}/confirm", json={"benefits": {"plans": [bad]}})
    assert response.status_code == 422


@pytest.mark.parametrize(
    ("data", "filename", "declared", "stored"),
    [
        (STUB_PDF, "stub.pdf", "application/pdf", "application/pdf"),
        (PNG, "stub.png", "image/png", "image/png"),
        (JPEG, "stub.jpg", "image/jpeg", "image/jpeg"),
        # The leading bytes decide, not the client's Content-Type.
        (PNG, "stub.pdf", "application/pdf", "image/png"),
    ],
)
def test_upload_sniffs_the_type(
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    data: bytes,
    filename: str,
    declared: str,
    stored: str,
) -> None:
    document_id = uploaded(client_as(user_a), data, filename=filename, content_type=declared)
    content_type, size = db_connection.execute(
        text("SELECT content_type, size_bytes FROM documents WHERE id = :id"), {"id": document_id}
    ).one()
    assert (content_type, size) == (stored, len(data))


def test_upload_refuses_other_files(client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    response = upload(client, b"GIF89a....", filename="x.gif", content_type="image/gif")
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_media_type"
    assert upload(client, b"").status_code == 422
    assert upload(client, STUB_PDF, type="tax_return").status_code == 422
    assert client.post("/docs", data={"type": "pay_stub"}).status_code == 422
    assert client.get("/docs").json() == []


def test_upload_size_limit(client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    at_limit = b"%PDF-" + b"0" * (MAX_BYTES - 5)
    assert upload(client, at_limit).status_code == 201
    over = upload(client, at_limit + b"0")
    assert over.status_code == 413
    assert over.json()["error"]["code"] == "file_too_large"


def test_oversized_content_length_is_refused_before_reading(
    client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    response = client.post(
        "/docs",
        content=b"tiny",
        headers={
            "Content-Type": "multipart/form-data; boundary=x",
            "Content-Length": str(MAX_BYTES + 70_000),
        },
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"


def test_rate_limit_is_ten_per_clock_hour(
    app: FastAPI, client_as: Client, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    clock = [dt.datetime(2026, 10, 21, 14, 59, 30, tzinfo=dt.UTC)]
    app.dependency_overrides[get_now] = lambda: clock[0]
    client = client_as(user_a)
    for _ in range(10):
        assert upload(client).status_code == 201
    refused = upload(client)
    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "rate_limited"
    assert refused.headers["Retry-After"] == "30"
    # Refused and failed uploads do not count; another user has their own limit.
    assert upload(client_as(user_b)).status_code == 201
    clock[0] = dt.datetime(2026, 10, 21, 15, 0, 0, tzinfo=dt.UTC)
    assert upload(client, b"GIF89a").status_code == 415
    for _ in range(10):
        assert upload(client).status_code == 201
    assert upload(client).status_code == 429


# Extract -----------------------------------------------------------------------------


def test_extract_is_idempotent_while_the_job_runs(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = uploaded(client)
    first = client.post(f"/docs/{document_id}/extract")
    second = client.post(f"/docs/{document_id}/extract")
    assert first.status_code == second.status_code == 202
    assert first.json() == second.json()
    assert empty_queue.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 1
    assert client.get(f"/docs/{document_id}").json()["status"] == "extracting"

    job = client.get(f"/jobs/{first.json()['job_id']}").json()
    assert (job["kind"], job["status"]) == ("ingest.extract", "queued")


def test_extract_again_after_the_job_finished(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = uploaded(client)
    extracted(client, empty_queue, document_id)
    again = client.post(f"/docs/{document_id}/extract")
    assert again.status_code == 202
    assert empty_queue.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 2
    detail = client.get(f"/docs/{document_id}").json()
    assert detail["status"] == "extracting"
    assert detail["proposal"] is None


def test_extract_refuses_offer_letters(client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    document_id = uploaded(client, type="offer_letter")
    response = client.post(f"/docs/{document_id}/extract")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "extraction_unsupported"


def test_extract_refuses_expired_documents(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    document_id = make_document(
        db_connection,
        user_a.id,
        with_blob=False,
        status="failed",
        status_reason="expired",
        deleted_at=dt.datetime(2026, 10, 1, tzinfo=dt.UTC),
    )
    response = client_as(user_a).post(f"/docs/{document_id}/extract")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "document_deleted"


def test_unknown_document_is_404(client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    missing = uuid.uuid4()
    assert client.get(f"/docs/{missing}").status_code == 404
    assert client.post(f"/docs/{missing}/extract").status_code == 404
    response = client.post(f"/docs/{missing}/confirm", json={"pay_stub": CONFIRMED})
    assert response.status_code == 404


def test_list_is_newest_first(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    old = make_document(
        db_connection, user_a.id, created_at=dt.datetime(2026, 10, 1, tzinfo=dt.UTC)
    )
    new = make_document(
        db_connection, user_a.id, created_at=dt.datetime(2026, 10, 2, tzinfo=dt.UTC)
    )
    listed = client_as(user_a).get("/docs").json()
    assert [d["id"] for d in listed] == [str(new), str(old)]
    assert listed[0]["uploaded_at"] == "2026-10-02T00:00:00Z"
    assert set(listed[0]) == {
        "id",
        "type",
        "status",
        "status_reason",
        "redaction_count",
        "page_count",
        "uploaded_at",
        "confirmed_at",
        "deleted_at",
        "replaced_by_id",
        "can_read_again",
    }
