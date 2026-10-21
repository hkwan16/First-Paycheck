"""Saving decisions: recompute, version chain, immutability and side effects (spec 007)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError, IntegrityError, ProgrammingError

from app.db import user_session_for
from app.deps import get_now
from tests.conftest import FixtureUser
from tests.support.factories import make_document, make_pay_stub

NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)

EXAMPLE_1: dict[str, Any] = {
    "salary_cents": 6_000_000,
    "pay_periods_per_year": 26,
    "match_tiers": [
        {"employee_pct_upto": "3", "employer_pct": "100"},
        {"employee_pct_upto": "5", "employer_pct": "50"},
    ],
    "contribution_pct": "3",
    "tax_year": 2026,
    "filing_status": "single",
    "age": 30,
}

Client = Callable[[FixtureUser], TestClient]


@pytest.fixture
def frozen(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_now] = lambda: NOW
    return app


def calc(client: TestClient, **changes: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    inputs = {**EXAMPLE_1, **changes}
    response = client.post("/calc/401k-match", json=inputs)
    assert response.status_code == 200, response.text
    return inputs, response.json()


def save(client: TestClient, supersedes_id: str | None = None, **changes: Any) -> dict[str, Any]:
    inputs, result = calc(client, **changes)
    response = client.post(
        "/decisions",
        json={
            "calculator": "k401_match",
            "inputs": inputs,
            "result": result,
            "supersedes_id": supersedes_id,
        },
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def count(connection: Connection, sql: str, **params: Any) -> int:
    return int(connection.execute(text(sql), params).scalar_one())


# ---------------------------------------------------------------- versioning


def test_v2_supersedes_v1(frozen: FastAPI, client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    v1 = save(client)
    assert v1["version"] == 1
    assert v1["supersedes_id"] is None
    assert v1["calculator"] == "k401_match"
    assert v1["goal_id"] is None

    v2 = save(client, supersedes_id=v1["decision_id"], contribution_pct="4")
    assert v2["version"] == 2
    assert v2["supersedes_id"] == v1["decision_id"]

    listing = client.get("/decisions")
    assert listing.status_code == 200
    [entry] = listing.json()["items"]
    assert entry["calculator"] == "k401_match"
    assert entry["current"]["id"] == v2["decision_id"]
    assert entry["current"]["version"] == 2
    assert entry["current"]["is_current"] is True
    assert entry["current"]["inputs"]["contribution_pct"] == "4.00"
    assert entry["current"]["result"]["employer_match_cents_current"] == 210_000
    assert [version["version"] for version in entry["versions"]] == [2, 1]

    old = client.get(f"/decisions/{v1['decision_id']}")
    assert old.status_code == 200
    assert old.json()["is_current"] is False
    assert old.json()["version"] == 1


def test_stored_values_are_the_servers(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    inputs, result = calc(client)
    # The same result written differently: "5" instead of "5.00".
    sent = {**result, "full_match_pct": "5", "marginal_rate_used": 12}
    response = client.post(
        "/decisions",
        json={"calculator": "k401_match", "inputs": inputs, "result": sent, "supersedes_id": None},
    )
    assert response.status_code == 201, response.text
    stored = db_connection.execute(
        text("SELECT inputs, result FROM decisions WHERE id = :id"),
        {"id": response.json()["decision_id"]},
    ).one()
    assert stored.result == result
    assert stored.inputs["contribution_pct"] == "3.00"
    assert stored.inputs["tax_year"] == 2026


def test_second_v2_rejected(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    v1 = save(client)
    save(client, supersedes_id=v1["decision_id"], contribution_pct="4")
    inputs, result = calc(client, contribution_pct="5")
    response = client.post(
        "/decisions",
        json={
            "calculator": "k401_match",
            "inputs": inputs,
            "result": result,
            "supersedes_id": v1["decision_id"],
        },
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "decision_conflict"
    assert (
        count(db_connection, "SELECT count(*) FROM decisions WHERE user_id = :u", u=user_a.id) == 2
    )


def test_second_v2_rejected_by_the_unique_index(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    """Two concurrent saves of the same next version: the database refuses the second."""
    v1 = insert_decision(db_connection, user_a, version=1)
    insert_decision(db_connection, user_a, version=2, supersedes_id=v1)
    with pytest.raises(IntegrityError, match=r"uq_decisions_supersedes_id|uq_decisions_user_id"):
        insert_decision(db_connection, user_a, version=2, supersedes_id=v1)


def test_second_v1_rejected(frozen: FastAPI, client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    save(client)
    inputs, result = calc(client, contribution_pct="4")
    response = client.post(
        "/decisions",
        json={
            "calculator": "k401_match",
            "inputs": inputs,
            "result": result,
            "supersedes_id": None,
        },
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "decision_conflict"


def test_superseding_a_stale_version_is_409(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    v1 = save(client)
    v2 = save(client, supersedes_id=v1["decision_id"], contribution_pct="4")
    save(client, supersedes_id=v2["decision_id"], contribution_pct="5")
    inputs, result = calc(client, contribution_pct="6")
    response = client.post(
        "/decisions",
        json={
            "calculator": "k401_match",
            "inputs": inputs,
            "result": result,
            "supersedes_id": v2["decision_id"],
        },
    )
    assert response.status_code == 409


def test_version_one_has_no_parent(db_connection: Connection, user_a: FixtureUser) -> None:
    with pytest.raises(IntegrityError, match="first_version_has_no_parent"):
        insert_decision(db_connection, user_a, version=2)


def test_parent_must_be_the_previous_version(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    v1 = insert_decision(db_connection, user_a, version=1)
    with pytest.raises(DBAPIError, match="must supersede version 2"):
        insert_decision(db_connection, user_a, version=3, supersedes_id=v1)


# ---------------------------------------------------------------- immutability


def test_direct_update_raises(db_connection: Connection, user_a: FixtureUser) -> None:
    decision = insert_decision(db_connection, user_a, version=1)
    # The table owner bypasses every policy; the trigger still refuses.
    with pytest.raises(DBAPIError, match="decisions are immutable"):
        db_connection.execute(
            text("UPDATE decisions SET result = '{}'::jsonb WHERE id = :id"), {"id": decision}
        )


def test_direct_delete_raises(db_connection: Connection, user_a: FixtureUser) -> None:
    decision = insert_decision(db_connection, user_a, version=1)
    with pytest.raises(DBAPIError, match="decisions are immutable"):
        db_connection.execute(text("DELETE FROM decisions WHERE id = :id"), {"id": decision})


def test_user_cannot_update_or_delete(db_connection: Connection, user_a: FixtureUser) -> None:
    decision = insert_decision(db_connection, user_a, version=1)
    for statement in (
        "UPDATE decisions SET version = 1 WHERE id = :id",
        "DELETE FROM decisions WHERE id = :id",
    ):
        with (
            pytest.raises(ProgrammingError, match="permission denied"),
            user_session_for(user_a.id, bind=db_connection) as session,
        ):
            session.execute(text(statement), {"id": decision})


def test_account_deletion_cascades(
    frozen: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    db_connection: Connection,
    seeded_citations: Connection,
) -> None:
    client = client_as(user_a)
    v1 = save(client)
    save(client, supersedes_id=v1["decision_id"], contribution_pct="4")
    explained = client.post("/explain", json={"decision_id": v1["decision_id"]})
    assert explained.status_code == 200, explained.text
    owned = (
        "SELECT (SELECT count(*) FROM decisions WHERE user_id = :u)"
        " + (SELECT count(*) FROM calendar_events WHERE user_id = :u)"
        " + (SELECT count(*) FROM explanations WHERE user_id = :u)"
    )
    assert count(db_connection, owned, u=user_a.id) == 5

    db_connection.execute(text("DELETE FROM auth.users WHERE id = :u"), {"u": user_a.id})

    assert count(db_connection, owned, u=user_a.id) == 0


# ---------------------------------------------------------------- ownership


def test_cannot_supersede_other_users_decision(
    frozen: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    user_b: FixtureUser,
    db_connection: Connection,
) -> None:
    v1 = save(client_as(user_a))
    inputs, result = calc(client_as(user_b))
    response = client_as(user_b).post(
        "/decisions",
        json={
            "calculator": "k401_match",
            "inputs": inputs,
            "result": result,
            "supersedes_id": v1["decision_id"],
        },
    )
    assert response.status_code == 404
    assert (
        count(db_connection, "SELECT count(*) FROM decisions WHERE user_id = :u", u=user_b.id) == 0
    )


def test_insert_policy_rejects_another_users_parent(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    v1 = insert_decision(db_connection, user_a, version=1)
    with pytest.raises(DBAPIError, match=r"row-level security|must supersede"):
        insert_decision(db_connection, user_b, version=2, supersedes_id=v1)


def test_composite_key_rejects_another_users_parent(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    """Even the table owner, past every policy and with the trigger satisfied,
    cannot point B's row at A's: the same-user foreign key refuses it."""
    v1 = insert_decision(db_connection, user_a, version=1)
    db_connection.execute(text("ALTER TABLE decisions DISABLE TRIGGER decisions_check_parent"))
    with pytest.raises(IntegrityError, match="fk_decisions_supersedes_id_decisions"):
        db_connection.execute(
            text(
                "INSERT INTO decisions (user_id, calculator, inputs, result, version,"
                " supersedes_id) VALUES (:u, 'k401_match', '{}', '{}', 2, :p)"
            ),
            {"u": user_b.id, "p": v1},
        )


# ---------------------------------------------------------------- validation


def test_result_mismatch_is_422(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    inputs, result = calc(client)
    tampered = {**result, "missed_cents": result["missed_cents"] + 1}
    response = client.post(
        "/decisions",
        json={
            "calculator": "k401_match",
            "inputs": inputs,
            "result": tampered,
            "supersedes_id": None,
        },
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "result_mismatch"
    assert error["details"] == {"fields": ["missed_cents"]}
    assert count(db_connection, "SELECT count(*) FROM decisions") == 0


def test_result_that_does_not_validate_is_a_mismatch(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    inputs, _ = calc(client)
    response = client.post(
        "/decisions",
        json={"calculator": "k401_match", "inputs": inputs, "result": {"nope": 1}},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "result_mismatch"


def test_invalid_inputs_are_422(frozen: FastAPI, client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    _, result = calc(client)
    response = client.post(
        "/decisions",
        json={
            "calculator": "k401_match",
            "inputs": {**EXAMPLE_1, "tax_year": 2027},
            "result": result,
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert "2027" in response.json()["error"]["message"]


def test_unregistered_calculator_is_422(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    response = client_as(user_a).post(
        "/decisions", json={"calculator": "w4", "inputs": {}, "result": {}}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "calculator_unavailable"


def test_supersedes_another_calculator_is_422(
    db_connection: Connection, frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    other = insert_decision(db_connection, user_a, version=1, calculator="emergency_fund")
    inputs, result = calc(client_as(user_a))
    response = client_as(user_a).post(
        "/decisions",
        json={
            "calculator": "k401_match",
            "inputs": inputs,
            "result": result,
            "supersedes_id": str(other),
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "supersedes_mismatch"


def test_unknown_decision_is_404(frozen: FastAPI, client_as: Client, user_a: FixtureUser) -> None:
    response = client_as(user_a).get(f"/decisions/{uuid.uuid4()}")
    assert response.status_code == 404


def test_no_decisions_lists_nothing(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    assert client_as(user_a).get("/decisions").json() == {"items": []}


# ---------------------------------------------------------------- calendar


def biweekly_with_stub(client: TestClient, connection: Connection, user: FixtureUser) -> None:
    profile = client.put("/profile", json={"salary_cents": 6_000_000, "pay_frequency": "biweekly"})
    assert profile.status_code == 200, profile.text
    document = make_document(connection, user.id, with_blob=False)
    make_pay_stub(connection, user.id, document, pay_date=dt.date(2026, 10, 16))


def test_calendar_event_created(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    biweekly_with_stub(client, db_connection, user_a)
    saved = save(client)
    assert saved["calendar_event_id"] is not None

    events = client.get("/calendar")
    assert events.status_code == 200
    assert events.json() == [
        {
            "id": saved["calendar_event_id"],
            "kind": "election_check",
            "title": "Check that your next pay stub shows your new 401(k) contribution",
            "due_at": "2026-10-30",
            "decision_id": saved["decision_id"],
            "status": "upcoming",
        }
    ]


def test_event_falls_back_to_pay_periods_without_a_profile(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    save(client, pay_periods_per_year=24)
    [event] = client.get("/calendar").json()
    assert event["due_at"] == "2026-10-31"  # semimonthly, no stub: the month end


def test_superseded_event_dismissed(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    biweekly_with_stub(client, db_connection, user_a)
    v1 = save(client)
    v2 = save(client, supersedes_id=v1["decision_id"], contribution_pct="4")
    statuses: dict[str, str] = dict(
        db_connection.execute(
            text("SELECT decision_id::text, status::text FROM calendar_events WHERE user_id = :u"),
            {"u": user_a.id},
        ).all()
    )
    assert statuses == {v1["decision_id"]: "dismissed", v2["decision_id"]: "upcoming"}
    assert [event["decision_id"] for event in client.get("/calendar").json()] == [v2["decision_id"]]


# ---------------------------------------------------------------- helpers


def insert_decision(
    connection: Connection,
    user: FixtureUser,
    *,
    version: int,
    supersedes_id: uuid.UUID | None = None,
    calculator: str = "k401_match",
) -> uuid.UUID:
    """A raw decision row, inserted as ``user`` under RLS."""
    with user_session_for(user.id, bind=connection) as session:
        decision_id: uuid.UUID = session.execute(
            text(
                "INSERT INTO decisions (user_id, calculator, inputs, result, version,"
                " supersedes_id)"
                " VALUES (:u, CAST(:c AS calculator_kind), '{}', '{}', :v, :p) RETURNING id"
            ),
            {"u": user.id, "c": calculator, "v": version, "p": supersedes_id},
        ).scalar_one()
    return decision_id
