"""W-4 decisions and their calendar reminder (spec 014 rules 17-18), and the
``w4_submit`` calendar kind from migration 0009_w4_calendar_kind."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, text

from app.db import user_session_for
from app.deps import get_now
from db.enums import CalendarKind
from tests.conftest import FixtureUser
from tests.integration.test_goals import biweekly_with_stub, events
from tests.support.database import downgrade, upgrade
from tests.support.factories import STUB_01, make_document, make_pay_stub

NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)
Client = Callable[[FixtureUser], TestClient]

# Spec 014 example 9: two jobs, both with Step 2 checked.
EXAMPLE_9: dict[str, Any] = {
    "salary_cents": 9_000_000,
    "pay_periods_per_year": 26,
    "filing_status": "married_filing_jointly",
    "tax_year": 2026,
    "multiple_jobs": True,
    "other_jobs_wages_cents": 3_000_000,
    "other_jobs_withholding_cents": 142_012,
}


@pytest.fixture
def frozen(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_now] = lambda: NOW
    return app


def save_w4(
    client: TestClient, inputs: dict[str, Any], supersedes_id: str | None = None
) -> dict[str, Any]:
    result = client.post("/calc/w4", json=inputs)
    assert result.status_code == 200, result.text
    response = client.post(
        "/decisions",
        json={
            "calculator": "w4",
            "inputs": inputs,
            "result": result.json(),
            "supersedes_id": supersedes_id,
        },
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def test_w4_decision_adds_the_submit_reminder(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    """Rule 18: due the next expected pay date; a biweekly stub paid 2026-10-16 makes
    that 2026-10-30."""
    client = client_as(user_a)
    biweekly_with_stub(client, db_connection, user_a)
    v1 = save_w4(client, EXAMPLE_9)
    assert v1["goal_id"] is None
    assert v1["calendar_event_id"] is not None
    assert events(db_connection, v1["decision_id"]) == [("w4_submit", "2026-10-30", "upcoming")]
    [event] = client.get("/calendar").json()
    assert event["title"] == "Give your employer your updated Form W-4"
    assert event["id"] == v1["calendar_event_id"]

    # The user takes the suggestion: Step 4(b) $10,683, expecting no deductions.
    v2 = save_w4(
        client,
        {**EXAMPLE_9, "deductions_cents": 1_068_300, "expected_deductions_cents": 0},
        supersedes_id=v1["decision_id"],
    )
    assert events(db_connection, v1["decision_id"]) == [("w4_submit", "2026-10-30", "dismissed")]
    assert events(db_connection, v2["decision_id"]) == [("w4_submit", "2026-10-30", "upcoming")]
    stored = client.get(f"/decisions/{v2['decision_id']}").json()
    assert stored["version"] == 2
    assert stored["result"]["projected_refund_cents"] == -10
    assert stored["result"]["suggestion"] == "none"


def test_w4_decision_keeps_the_comparison_with_the_stub(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    """Spec 014 example 11 (issue 153's e2e account): the confirmed stub-01 withholds
    $272.44 a paycheck; the client copies it in, and the saved result keeps rule 10a's
    $3,918.70 balance due beside the entries' 2-cent refund (rule 17a)."""
    client = client_as(user_a)
    document = make_document(db_connection, user_a.id, with_blob=False)
    make_pay_stub(db_connection, user_a.id, document, **STUB_01)
    [stub] = client.get("/pay-stubs").json()
    inputs = {
        "salary_cents": stub["annual_salary_cents"],
        "pay_periods_per_year": 26,
        "filing_status": "single",
        "tax_year": stub["tax_year"],
        "k401_contribution_pct": "5.00",
        "age": 24,
        "health_premium_per_paycheck_cents": 400,
        "current_withholding_per_paycheck_cents": stub["federal_withholding_cents"],
    }
    saved = save_w4(client, inputs)
    stored = client.get(f"/decisions/{saved['decision_id']}").json()
    assert stored["inputs"]["current_withholding_per_paycheck_cents"] == 27_244
    result = stored["result"]
    assert (result["withholding_per_paycheck_cents"], result["projected_refund_cents"]) == (
        42_316,
        2,
    )
    assert (result["current_annual_withholding_cents"], result["current_refund_cents"]) == (
        708_344,
        -391_870,
    )


def test_w4_decision_without_pay_history_uses_the_pay_periods(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    """No profile and no stub: 26 periods means biweekly, so today + 14 days."""
    saved = save_w4(client_as(user_a), EXAMPLE_9)
    assert events(db_connection, saved["decision_id"]) == [("w4_submit", "2026-11-04", "upcoming")]


def test_w4_result_mismatch_saves_nothing(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    result = client.post("/calc/w4", json=EXAMPLE_9).json()
    result["suggested_deductions_cents"] += 100
    response = client.post(
        "/decisions", json={"calculator": "w4", "inputs": EXAMPLE_9, "result": result}
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == ["suggested_deductions_cents"]
    assert db_connection.execute(text("SELECT count(*) FROM calendar_events")).scalar_one() == 0


def test_w4_submit_is_a_calendar_kind(db_connection: Connection, user_a: FixtureUser) -> None:
    labels = db_connection.execute(
        text("SELECT enum_range(NULL::calendar_kind)::text[]")
    ).scalar_one()
    assert labels == [kind.value for kind in CalendarKind]
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(
            text(
                "INSERT INTO calendar_events (user_id, kind, title, due_at)"
                " VALUES (:u, 'w4_submit', 'W-4', '2026-10-30')"
            ),
            {"u": user_a.id},
        )


def test_0009_downgrade_removes_the_kind_and_its_events(
    scratch_database: tuple[str, Engine],
) -> None:
    url, engine = scratch_database
    upgrade(url, "head")
    user = "00000000-0000-4000-8000-0000000000c9"
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": user})
        for kind in ("w4_submit", "goal_review"):
            connection.execute(
                text(
                    "INSERT INTO calendar_events (user_id, kind, title, due_at)"
                    " VALUES (:u, :kind, 'Event', '2026-10-30')"
                ),
                {"u": user, "kind": kind},
            )
    downgrade(url, "0011_no_model_reason")
    with engine.connect() as connection:
        labels = connection.execute(
            text("SELECT enum_range(NULL::calendar_kind)::text[]")
        ).scalar_one()
        kinds = connection.execute(text("SELECT kind::text FROM calendar_events")).scalars()
        assert "w4_submit" not in labels
        assert list(kinds) == ["goal_review"]
    upgrade(url, "head")
