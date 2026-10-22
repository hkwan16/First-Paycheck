"""``POST /plan/export``, the ``plan.export`` job and ``GET /plan/export/{job_id}``
(spec 016 rules 9-16, examples 17-21)."""

from __future__ import annotations

import io
import uuid
from collections.abc import Callable
from typing import Any

import pdfplumber
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from db.enums import JobKind
from jobs.context import JobContext, Services
from jobs.handlers import plan_export
from jobs.queue import ClaimedJob
from jobs.worker import Worker
from tests.conftest import FixtureUser
from tests.support.factories import make_job
from tests.support.plan_user import NOW, PlanUser

Client = Callable[[FixtureUser], TestClient]


def queue_export(client: TestClient) -> str:
    response = client.post("/plan/export")
    assert response.status_code == 202, response.text
    job_id: str = response.json()["job_id"]
    return job_id


def job(connection: Connection, job_id: str) -> dict[str, Any]:
    row = connection.execute(
        text("SELECT kind::text, status::text, payload, result, user_id FROM jobs WHERE id = :id"),
        {"id": job_id},
    ).one()
    return dict(row._mapping)


def pdf_pages(data: bytes) -> list[str]:
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        return [page.extract_text() or "" for page in pdf.pages]


def test_export_queues_one_job(
    frozen_app: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    first = queue_export(client)
    assert queue_export(client) == first
    assert job(db_connection, first) == {
        "kind": "plan.export",
        "status": "queued",
        "payload": {},
        "result": None,
        "user_id": user_a.id,
    }
    count = db_connection.execute(
        text("SELECT count(*) FROM jobs WHERE kind = 'plan.export'")
    ).scalar_one()
    assert count == 1


def test_download_is_404_until_the_job_succeeds(
    weasyprint: None,
    plan_user: PlanUser,
    client_as: Client,
    user_a: FixtureUser,
    db_connection: Connection,
    worker: Worker,
) -> None:
    client = client_as(user_a)
    job_id = queue_export(client)
    waiting = client.get(f"/plan/export/{job_id}")
    assert waiting.status_code == 404
    assert waiting.json()["error"]["code"] == "not_found"

    assert worker.run_once() is True
    finished = job(db_connection, job_id)
    assert finished["status"] == "succeeded"
    assert finished["result"]["size_bytes"] > 0
    assert client.get(f"/plan/export/{job_id}").status_code == 200


def test_pdf_has_two_pages_and_the_plan_text(
    weasyprint: None,
    plan_user: PlanUser,
    client_as: Client,
    user_a: FixtureUser,
    worker: Worker,
) -> None:
    client = client_as(user_a)
    job_id = queue_export(client)
    worker.run_once()
    response = client.get(f"/plan/export/{job_id}")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="first-paycheck-plan-2026-10-21.pdf"'
    )
    plan_page, calendar_page = pdf_pages(response.content)
    for expected in (
        "First Paycheck plan",
        "Acme Corp",
        "Prepared Oct 21, 2026",
        "$2,708.33",
        "$5,469.00",
        "$2,600.00",
        "Bronze HSA",
        "Federal withholding per paycheck",
        "Verified against the calculator",
    ):
        assert expected in plan_page, expected
    for expected in (
        # Section headings are set in capitals by the stylesheet.
        "DECISION CALENDAR",
        "Oct 31, 2026",
        "Health plan enrollment deadline",
        "WHY, WITH SOURCES",
        "https://www.irs.gov/",
    ):
        assert expected in calendar_page, expected
    assert "Review your emergency fund progress" not in calendar_page


def test_export_job_reads_as_its_user(
    weasyprint: None,
    plan_user: PlanUser,
    client_as: Client,
    user_a: FixtureUser,
    user_b: FixtureUser,
    db_connection: Connection,
    worker: Worker,
) -> None:
    job_id = queue_export(client_as(user_b))
    worker.run_once()
    owner = db_connection.execute(
        text("SELECT user_id FROM plan_exports WHERE job_id = :id"), {"id": job_id}
    ).scalar_one()
    assert owner == user_b.id
    response = client_as(user_b).get(f"/plan/export/{job_id}")
    assert response.status_code == 200
    text_of_b = "\n".join(pdf_pages(response.content))
    assert "No decisions saved yet." in text_of_b
    for figure in ("Acme Corp", "$5,469.00", "Bronze HSA"):
        assert figure not in text_of_b
    assert client_as(user_a).get(f"/plan/export/{job_id}").status_code == 404


def test_a_rerun_keeps_the_first_export(
    weasyprint: None,
    plan_user: PlanUser,
    client_as: Client,
    user_a: FixtureUser,
    db_connection: Connection,
) -> None:
    job_id = uuid.UUID(queue_export(client_as(user_a)))
    claimed = ClaimedJob(
        id=job_id, kind=JobKind.PLAN_EXPORT, user_id=user_a.id, payload={}, attempts=1
    )
    ctx = JobContext(
        job=claimed,
        services=Services(clock=lambda: NOW),
        queue_bind=db_connection,
        user_bind=db_connection,
    )
    first = plan_export.run(ctx)
    assert first["size_bytes"] > 0
    stored = db_connection.execute(
        text("SELECT bytes FROM plan_exports WHERE job_id = :id"), {"id": job_id}
    ).scalar_one()
    assert plan_export.run(ctx) == {"status": "skipped"}
    again = db_connection.execute(
        text("SELECT bytes FROM plan_exports WHERE job_id = :id"), {"id": job_id}
    ).scalar_one()
    assert again == stored


def test_download_of_another_kind_of_job_is_404(
    frozen_app: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    other = make_job(db_connection, user_a.id, kind=JobKind.INGEST_EXTRACT)
    db_connection.execute(
        text("UPDATE jobs SET status = 'succeeded' WHERE id = :id"), {"id": other}
    )
    response = client_as(user_a).get(f"/plan/export/{other}")
    assert response.status_code == 404


def test_download_of_an_unknown_job_is_404(
    frozen_app: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    assert client_as(user_a).get(f"/plan/export/{uuid.uuid4()}").status_code == 404
