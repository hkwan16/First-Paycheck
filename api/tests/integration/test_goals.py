"""Emergency-fund and health-plan decisions, goals and their calendar events
(spec 011 rules 9-17, spec 012 rules 13-15)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.deps import get_now
from db.enums import AccountKind, AccountRole
from tests.conftest import FixtureUser
from tests.support.factories import (
    make_account,
    make_document,
    make_item,
    make_pay_stub,
    make_snapshot,
)
from tests.unit.calc.test_health_plans_examples import A, B
from tests.unit.calc.test_health_plans_examples import payload as health_payload

NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)
Client = Callable[[FixtureUser], TestClient]

# Spec 011 example 1.
EXAMPLE_1: dict[str, Any] = {
    "monthly_essentials_cents": 250_000,
    "target_months": 3,
    "current_balance_cents": 0,
    "monthly_contribution_cents": 50_000,
    "pay_periods_per_year": 26,
}
# Spec 011 example 3.
FUNDED: dict[str, Any] = {
    "monthly_essentials_cents": 200_000,
    "target_months": 3,
    "current_balance_cents": 700_000,
    "monthly_contribution_cents": 30_000,
    "pay_periods_per_year": 26,
}


@pytest.fixture
def frozen(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_now] = lambda: NOW
    return app


def save(
    client: TestClient,
    calculator: str,
    route: str,
    inputs: dict[str, Any],
    supersedes_id: str | None = None,
    *,
    status: int = 201,
) -> dict[str, Any]:
    result = client.post(route, json=inputs)
    assert result.status_code == 200, result.text
    response = client.post(
        "/decisions",
        json={
            "calculator": calculator,
            "inputs": inputs,
            "result": result.json(),
            "supersedes_id": supersedes_id,
        },
    )
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()
    return body


def save_fund(client: TestClient, inputs: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    return save(client, "emergency_fund", "/calc/emergency-fund", inputs, **kwargs)


def save_health(client: TestClient, inputs: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    return save(client, "health_plans", "/calc/health-plans", inputs, **kwargs)


def biweekly_with_stub(client: TestClient, connection: Connection, user: FixtureUser) -> None:
    profile = client.put("/profile", json={"salary_cents": 6_500_000, "pay_frequency": "biweekly"})
    assert profile.status_code == 200, profile.text
    document = make_document(connection, user.id, with_blob=False)
    make_pay_stub(connection, user.id, document, pay_date=dt.date(2026, 10, 16))


def fund_account(connection: Connection, user: FixtureUser) -> uuid.UUID:
    item = make_item(connection, user.id)
    account = make_account(
        connection,
        user.id,
        item,
        kind=AccountKind.SAVINGS,
        role=AccountRole.EMERGENCY_FUND,
        provider_account_id="savings-1",
    )
    return account


def events(connection: Connection, decision_id: str) -> list[tuple[str, str, str]]:
    rows = connection.execute(
        text(
            "SELECT kind::text, due_at::text, status::text FROM calendar_events"
            " WHERE decision_id = :d ORDER BY due_at"
        ),
        {"d": decision_id},
    ).all()
    return [(row[0], row[1], row[2]) for row in rows]


# ---------------------------------------------------------------- spec 011 decisions


def test_save_creates_goal_and_events(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    biweekly_with_stub(client, db_connection, user_a)
    account = fund_account(db_connection, user_a)
    saved = save_fund(client, EXAMPLE_1)

    [goal] = client.get("/goals").json()
    assert saved["goal_id"] == goal["id"]
    assert goal["kind"] == "emergency_fund"
    assert goal["status"] == "active"
    assert goal["target_amount_cents"] == 750_000
    assert goal["monthly_contribution_cents"] == 50_000
    assert goal["account_id"] == str(account)
    assert goal["decision_id"] == saved["decision_id"]
    assert goal["target_date"] == "2027-12-30"
    assert goal["reached_at"] is None

    assert events(db_connection, saved["decision_id"]) == [
        ("goal_contribution", "2026-10-30", "upcoming"),
        ("goal_review", "2027-01-30", "upcoming"),
    ]
    calendar = client.get("/calendar").json()
    assert [event["title"] for event in calendar] == [
        "Make your first emergency fund contribution",
        "Review your emergency fund progress",
    ]
    assert saved["calendar_event_id"] == calendar[1]["id"]


def test_v2_updates_goal_and_dismisses_events(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    biweekly_with_stub(client, db_connection, user_a)
    v1 = save_fund(client, EXAMPLE_1)
    v2 = save_fund(
        client,
        {**EXAMPLE_1, "monthly_contribution_cents": 75_000},
        supersedes_id=v1["decision_id"],
    )
    goals = client.get("/goals").json()
    assert len(goals) == 1
    assert goals[0]["id"] == v1["goal_id"] == v2["goal_id"]
    assert goals[0]["monthly_contribution_cents"] == 75_000
    assert goals[0]["target_date"] == "2027-07-30"
    assert goals[0]["decision_id"] == v2["decision_id"]
    assert events(db_connection, v1["decision_id"]) == [
        ("goal_contribution", "2026-10-30", "dismissed"),
        ("goal_review", "2027-01-30", "dismissed"),
    ]
    assert events(db_connection, v2["decision_id"]) == [
        ("goal_contribution", "2026-10-30", "upcoming"),
        ("goal_review", "2027-01-30", "upcoming"),
    ]


def test_funded_save_has_no_contribution_event(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    biweekly_with_stub(client, db_connection, user_a)
    saved = save_fund(client, FUNDED)
    [goal] = client.get("/goals").json()
    assert goal["target_date"] is None
    assert goal["account_id"] is None
    assert events(db_connection, saved["decision_id"]) == [
        ("goal_review", "2027-01-30", "upcoming")
    ]


def test_unreachable_save_has_no_target_date(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    saved = save_fund(client, {**EXAMPLE_1, "monthly_contribution_cents": 0})
    [goal] = client.get("/goals").json()
    assert goal["target_date"] is None
    assert saved["calendar_event_id"] is not None


def test_saving_again_reactivates_a_reached_goal(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    v1 = save_fund(client, EXAMPLE_1)
    assert client.patch(f"/goals/{v1['goal_id']}", json={"status": "reached"}).status_code == 200
    save_fund(client, EXAMPLE_1, supersedes_id=v1["decision_id"])
    [goal] = client.get("/goals").json()
    assert (goal["status"], goal["reached_at"]) == ("active", None)


def test_an_existing_link_is_kept(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    v1 = save_fund(client, EXAMPLE_1)
    account = fund_account(db_connection, user_a)
    save_fund(client, EXAMPLE_1, supersedes_id=v1["decision_id"])
    assert client.get("/goals").json()[0]["account_id"] == str(account)


# ---------------------------------------------------------------- PATCH /goals


def test_patch_pause_and_reach(frozen: FastAPI, client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    goal_id = save_fund(client, EXAMPLE_1)["goal_id"]
    paused = client.patch(f"/goals/{goal_id}", json={"status": "paused"})
    assert paused.status_code == 200, paused.text
    assert (paused.json()["status"], paused.json()["reached_at"]) == ("paused", None)
    reached = client.patch(f"/goals/{goal_id}", json={"status": "reached"})
    assert (reached.json()["status"], reached.json()["reached_at"]) == (
        "reached",
        "2026-10-21T15:00:00Z",
    )
    active = client.patch(f"/goals/{goal_id}", json={"status": "active"})
    assert (active.json()["status"], active.json()["reached_at"]) == ("active", None)


def test_patch_contribution_clears_target_date(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    goal_id = save_fund(client, EXAMPLE_1)["goal_id"]
    patched = client.patch(f"/goals/{goal_id}", json={"monthly_contribution_cents": 60_000})
    assert patched.status_code == 200, patched.text
    assert patched.json()["monthly_contribution_cents"] == 60_000
    assert patched.json()["target_date"] is None


def test_patch_links_and_unlinks_an_account(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    goal_id = save_fund(client, EXAMPLE_1)["goal_id"]
    account = fund_account(db_connection, user_a)
    linked = client.patch(f"/goals/{goal_id}", json={"account_id": str(account)})
    assert linked.json()["account_id"] == str(account)
    target_date = linked.json()["target_date"]
    unlinked = client.patch(f"/goals/{goal_id}", json={"account_id": None})
    assert unlinked.json()["account_id"] is None
    assert unlinked.json()["target_date"] == target_date


@pytest.mark.parametrize(
    "body",
    [{}, {"status": "done"}, {"monthly_contribution_cents": -1}, {"surprise": 1}],
)
def test_patch_validates(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, body: dict[str, Any]
) -> None:
    client = client_as(user_a)
    goal_id = save_fund(client, EXAMPLE_1)["goal_id"]
    assert client.patch(f"/goals/{goal_id}", json=body).status_code == 422


def test_patch_with_another_users_account_is_404(
    frozen: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    user_b: FixtureUser,
    db_connection: Connection,
) -> None:
    goal_id = save_fund(client_as(user_a), EXAMPLE_1)["goal_id"]
    other = fund_account(db_connection, user_b)
    response = client_as(user_a).patch(f"/goals/{goal_id}", json={"account_id": str(other)})
    assert response.status_code == 404
    assert client_as(user_a).get("/goals").json()[0]["account_id"] is None


def test_goal_progress_from_latest_snapshot(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    account = fund_account(db_connection, user_a)
    save_fund(client, EXAMPLE_1)
    for day, balance in ((1, 100_000), (15, 187_500)):
        make_snapshot(
            db_connection,
            user_a.id,
            account,
            balance_cents=balance,
            as_of=dt.datetime(2026, 10, day, 12, tzinfo=dt.UTC),
        )
    [goal] = client.get("/goals").json()
    assert goal["current_balance_cents"] == 187_500
    assert goal["progress_pct"] == "25.00"


def test_goal_without_account_has_no_progress(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    save_fund(client, EXAMPLE_1)
    [goal] = client.get("/goals").json()
    assert (goal["current_balance_cents"], goal["progress_pct"]) == (None, None)


# ---------------------------------------------------------------- spec 012 decisions


def health_inputs(**extra: Any) -> dict[str, Any]:
    return health_payload([A, B], 6_500_000, 100_000, **extra)


def test_health_decision_needs_a_selected_plan(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    body = save_health(client_as(user_a), health_inputs(), status=422)
    assert body["error"]["code"] == "plan_not_selected"
    assert db_connection.execute(text("SELECT count(*) FROM decisions")).scalar_one() == 0


def test_health_decision_adds_the_enrollment_deadline(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    v1 = save_health(client, health_inputs(selected_plan_index=0, enrollment_deadline="2026-11-15"))
    assert v1["goal_id"] is None
    assert v1["calendar_event_id"] is not None
    assert events(db_connection, v1["decision_id"]) == [
        ("enrollment_deadline", "2026-11-15", "upcoming")
    ]
    [event] = client.get("/calendar").json()
    assert event["title"] == "Health plan enrollment deadline"

    v2 = save_health(
        client,
        health_inputs(selected_plan_index=1, enrollment_deadline="2026-11-20"),
        supersedes_id=v1["decision_id"],
    )
    assert events(db_connection, v1["decision_id"]) == [
        ("enrollment_deadline", "2026-11-15", "dismissed")
    ]
    assert events(db_connection, v2["decision_id"]) == [
        ("enrollment_deadline", "2026-11-20", "upcoming")
    ]


@pytest.mark.parametrize("deadline", [None, "2026-10-20"])
def test_health_decision_without_a_future_deadline_adds_no_event(
    frozen: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    db_connection: Connection,
    deadline: str | None,
) -> None:
    saved = save_health(
        client_as(user_a), health_inputs(selected_plan_index=0, enrollment_deadline=deadline)
    )
    assert saved["calendar_event_id"] is None
    assert events(db_connection, saved["decision_id"]) == []


def test_health_decision_deadline_today_is_kept(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    saved = save_health(
        client_as(user_a), health_inputs(selected_plan_index=0, enrollment_deadline="2026-10-21")
    )
    assert saved["calendar_event_id"] is not None
