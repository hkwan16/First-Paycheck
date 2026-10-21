"""Every user route, attempted by user B on user A's data.

``ROUTE_CASES`` maps each ``(method, path)`` to a builder that creates the
resource as user A and returns the request user B makes plus what B must see:
404, an empty result, or a refusal, and A's data unchanged afterwards. The
meta-test fails when a route is added without a case here.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute, iter_route_contexts
from fastapi.testclient import TestClient
from sqlalchemy import Connection, select, text
from sqlalchemy.sql import column, func, table

from db.enums import AccountRole, JobKind
from tests.conftest import USER_A, USER_B, FixtureUser
from tests.support.factories import (
    MOCKUP_STUB,
    make_account,
    make_document,
    make_item,
    make_job,
    make_pay_stub,
    make_recurring_charge,
    make_transaction,
)

# Routes with no user data behind them, or no user at all. The calculators
# are stateless: they read and write nothing (spec 007 rule 6).
EXEMPT = {
    ("GET", "/health"),
    ("POST", "/sync/webhook"),
    ("POST", "/calc/401k-match"),
    ("POST", "/calc/emergency-fund"),
    ("POST", "/calc/health-plans"),
}


@dataclass
class Case:
    """B's request and what B must get back."""

    method: str
    path: str
    status: int
    json: dict[str, Any] | None = None
    # A multipart body: form fields and files.
    form: dict[str, str] | None = None
    files: dict[str, tuple[str, bytes, str]] | None = None
    # Extra checks on B's response body.
    body: Callable[[Any], None] | None = None
    # Checks that A's data is untouched, run against the test connection.
    after: Callable[[Connection], None] | None = None


Builder = Callable[[Connection, Callable[[FixtureUser], TestClient]], Case]


def count(connection: Connection, name: str, user: FixtureUser) -> int:
    rows = table(name, column("user_id"))
    return int(
        connection.execute(
            select(func.count()).select_from(rows).where(rows.c.user_id == user.id)
        ).scalar_one()
    )


def a_item(connection: Connection) -> uuid.UUID:
    return make_item(connection, USER_A.id)


def a_account(connection: Connection) -> uuid.UUID:
    return make_account(connection, USER_A.id, a_item(connection), role=AccountRole.SPENDING)


def a_transaction(connection: Connection) -> uuid.UUID:
    return make_transaction(connection, USER_A.id, a_account(connection))


def link_token(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    def body(data: Any) -> None:
        assert str(USER_B.id) in data["link_token"]
        assert str(USER_A.id) not in data["link_token"]

    return Case("POST", "/sync/link-token", 200, body=body)


def link_item(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    linked = client_as(USER_A).post("/sync/items", json={"public_token": "public-sandbox-shared"})
    assert linked.status_code == 201

    def after(conn: Connection) -> None:
        assert count(conn, "sync_items", USER_B) == 0
        assert count(conn, "sync_items", USER_A) == 1

    return Case(
        "POST", "/sync/items", 409, json={"public_token": "public-sandbox-shared"}, after=after
    )


def delete_item(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    item = a_item(connection)

    def after(conn: Connection) -> None:
        assert count(conn, "sync_items", USER_A) == 1

    return Case("DELETE", f"/sync/items/{item}", 404, after=after)


def sync_item(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    item = a_item(connection)
    connection.execute(text("DELETE FROM jobs"))

    def after(conn: Connection) -> None:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 0

    return Case("POST", f"/sync/items/{item}/sync", 404, after=after)


def list_accounts(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    a_account(connection)

    def body(data: Any) -> None:
        assert data == []

    return Case("GET", "/accounts", 200, body=body)


def update_account(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    account = a_account(connection)

    def after(conn: Connection) -> None:
        role = conn.execute(
            text("SELECT role::text FROM accounts WHERE id = :id"), {"id": account}
        ).scalar_one()
        assert role == "spending"

    return Case("PATCH", f"/accounts/{account}", 404, json={"role": "emergency_fund"}, after=after)


def import_csv(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    imported = client_as(USER_A).post(
        "/accounts/import",
        data={"kind": "checking"},
        files={"file": ("a.csv", b"Date,Description,Amount\n2026-10-01,A,-1.00\n", "text/csv")},
    )
    assert imported.status_code == 200, imported.text
    account = imported.json()["account"]["id"]

    def after(conn: Connection) -> None:
        assert count(conn, "transactions", USER_A) == 1
        assert count(conn, "transactions", USER_B) == 0
        assert count(conn, "sync_items", USER_B) == 0

    return Case(
        "POST",
        "/accounts/import",
        404,
        form={"account_id": account},
        files={"file": ("b.csv", b"Date,Description,Amount\n2026-10-02,B,-2.00\n", "text/csv")},
        after=after,
    )


def list_transactions(
    connection: Connection, client_as: Callable[[FixtureUser], TestClient]
) -> Case:
    a_transaction(connection)

    def body(data: Any) -> None:
        assert data == {"items": [], "next_cursor": None}

    return Case("GET", "/transactions", 200, body=body)


def update_transaction(
    connection: Connection, client_as: Callable[[FixtureUser], TestClient]
) -> Case:
    txn = a_transaction(connection)

    def after(conn: Connection) -> None:
        category = conn.execute(
            text("SELECT category FROM transactions WHERE id = :id"), {"id": txn}
        ).scalar_one()
        assert category is None
        assert count(conn, "category_rules", USER_B) == 0

    return Case("PATCH", f"/transactions/{txn}", 404, json={"category": "dining"}, after=after)


def get_job(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    job = make_job(connection, USER_A.id, kind=JobKind.SYNC_INITIAL)
    return Case("GET", f"/jobs/{job}", 404)


def a_document(connection: Connection, **fields: Any) -> uuid.UUID:
    return make_document(connection, USER_A.id, **fields)


def a_profile(connection: Connection) -> None:
    connection.execute(
        text("INSERT INTO profiles (user_id, salary_cents, dependents) VALUES (:u, 6500000, 2)"),
        {"u": USER_A.id},
    )


def a_profile_unchanged(connection: Connection) -> None:
    salary, dependents = connection.execute(
        text("SELECT salary_cents, dependents FROM profiles WHERE user_id = :u"), {"u": USER_A.id}
    ).one()
    assert (salary, dependents) == (6_500_000, 2)


def upload_document(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    a_document(connection)
    created: list[str] = []

    def body(data: Any) -> None:
        created.append(data["document_id"])

    def after(conn: Connection) -> None:
        assert count(conn, "documents", USER_A) == 1
        assert count(conn, "documents", USER_B) == 1
        owner = conn.execute(
            text("SELECT user_id FROM documents WHERE id = :id"), {"id": created[0]}
        ).scalar_one()
        assert owner == USER_B.id

    return Case(
        "POST",
        "/docs",
        201,
        form={"type": "pay_stub"},
        files={"file": ("b.pdf", b"%PDF-1.4 b", "application/pdf")},
        body=body,
        after=after,
    )


def list_documents(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    a_document(connection)

    def body(data: Any) -> None:
        assert data == []

    return Case("GET", "/docs", 200, body=body)


def get_document(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    document = a_document(connection, status="proposed", proposal={"fields": []})
    return Case("GET", f"/docs/{document}", 404)


def extract_document(
    connection: Connection, client_as: Callable[[FixtureUser], TestClient]
) -> Case:
    document = a_document(connection)
    connection.execute(text("DELETE FROM jobs"))

    def after(conn: Connection) -> None:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 0
        status = conn.execute(
            text("SELECT status::text FROM documents WHERE id = :id"), {"id": document}
        ).scalar_one()
        assert status == "uploaded"

    return Case("POST", f"/docs/{document}/extract", 404, after=after)


def confirm_document(
    connection: Connection, client_as: Callable[[FixtureUser], TestClient]
) -> Case:
    document = a_document(connection, status="proposed", proposal={"fields": []})
    values = {
        **{key: value for key, value in MOCKUP_STUB.items() if not isinstance(value, dt.date)},
        "pay_frequency": "semimonthly",
        "pay_date": "2026-10-15",
        "period_start": "2026-10-01",
        "period_end": "2026-10-15",
    }

    def after(conn: Connection) -> None:
        assert conn.execute(text("SELECT count(*) FROM pay_stubs")).scalar_one() == 0
        blobs = conn.execute(
            text("SELECT count(*) FROM document_blobs WHERE document_id = :id"), {"id": document}
        ).scalar_one()
        assert blobs == 1

    return Case("POST", f"/docs/{document}/confirm", 404, json={"pay_stub": values}, after=after)


def list_benefits_plans(
    connection: Connection, client_as: Callable[[FixtureUser], TestClient]
) -> Case:
    document = a_document(connection, type="benefits", with_blob=False)
    connection.execute(
        text(
            "INSERT INTO benefits_plans (user_id, document_id, name, kind,"
            " premium_per_period_cents, deductible_cents, oop_max_cents, coinsurance_pct)"
            " VALUES (:u, :d, 'Gold PPO', 'ppo', 6250, 50000, 300000, 10)"
        ),
        {"u": USER_A.id, "d": document},
    )

    def body(data: Any) -> None:
        assert data == []

    return Case("GET", "/benefits-plans", 200, body=body)


def list_pay_stubs(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    make_pay_stub(connection, USER_A.id, a_document(connection, with_blob=False))

    def body(data: Any) -> None:
        assert data == []

    return Case("GET", "/pay-stubs", 200, body=body)


def get_profile(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    a_profile(connection)

    def body(data: Any) -> None:
        assert data["salary_cents"] is None
        assert data["updated_at"] is None

    return Case("GET", "/profile", 200, body=body)


def put_profile(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    a_profile(connection)
    return Case("PUT", "/profile", 200, json={"salary_cents": 1}, after=a_profile_unchanged)


K401_INPUTS: dict[str, Any] = {
    "salary_cents": 6_000_000,
    "pay_periods_per_year": 26,
    "match_tiers": [{"employee_pct_upto": "3", "employer_pct": "100"}],
    "contribution_pct": "3",
    "tax_year": 2026,
    "filing_status": "single",
    "age": 30,
}


def a_decision(client_as: Callable[[FixtureUser], TestClient], *, explained: bool = False) -> str:
    """A's saved 401(k) decision (with its calendar event), saved through the API."""
    client = client_as(USER_A)
    result = client.post("/calc/401k-match", json=K401_INPUTS).json()
    saved = client.post(
        "/decisions",
        json={"calculator": "k401_match", "inputs": K401_INPUTS, "result": result},
    )
    assert saved.status_code == 201, saved.text
    decision_id: str = saved.json()["decision_id"]
    if explained:
        assert client.post("/explain", json={"decision_id": decision_id}).status_code == 200
    return decision_id


def a_decisions_unchanged(conn: Connection) -> None:
    assert count(conn, "decisions", USER_A) == 1
    assert count(conn, "decisions", USER_B) == 0
    assert count(conn, "calendar_events", USER_B) == 0


def save_decision(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    decision = a_decision(client_as)
    inputs = {**K401_INPUTS, "contribution_pct": "4"}
    result = client_as(USER_B).post("/calc/401k-match", json=inputs).json()
    body = {
        "calculator": "k401_match",
        "inputs": inputs,
        "result": result,
        "supersedes_id": decision,
    }
    return Case("POST", "/decisions", 404, json=body, after=a_decisions_unchanged)


def list_decisions(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    a_decision(client_as)

    def body(data: Any) -> None:
        assert data == {"items": []}

    return Case("GET", "/decisions", 200, body=body)


def get_decision(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    return Case("GET", f"/decisions/{a_decision(client_as)}", 404)


def get_explanation(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    decision = a_decision(client_as, explained=True)
    return Case("GET", f"/decisions/{decision}/explanation", 404)


def explain(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    decision = a_decision(client_as, explained=True)
    before = count(connection, "explanations", USER_A)

    def after(conn: Connection) -> None:
        assert count(conn, "explanations", USER_A) == before
        assert count(conn, "explanations", USER_B) == 0
        assert count(conn, "llm_calls", USER_B) == 0

    return Case("POST", "/explain", 404, json={"decision_id": decision, "force": True}, after=after)


EMERGENCY_FUND_INPUTS: dict[str, Any] = {
    "monthly_essentials_cents": 250_000,
    "target_months": 3,
    "current_balance_cents": 0,
    "monthly_contribution_cents": 50_000,
    "pay_periods_per_year": 26,
}


def a_goal(client_as: Callable[[FixtureUser], TestClient]) -> str:
    """A's emergency-fund goal, created by saving a decision through the API."""
    client = client_as(USER_A)
    result = client.post("/calc/emergency-fund", json=EMERGENCY_FUND_INPUTS).json()
    saved = client.post(
        "/decisions",
        json={"calculator": "emergency_fund", "inputs": EMERGENCY_FUND_INPUTS, "result": result},
    )
    assert saved.status_code == 201, saved.text
    goal_id: str = saved.json()["goal_id"]
    return goal_id


def list_goals(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    a_goal(client_as)

    def body(data: Any) -> None:
        assert data == []

    return Case("GET", "/goals", 200, body=body)


def update_goal(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    goal = a_goal(client_as)

    def after(conn: Connection) -> None:
        row = conn.execute(
            text("SELECT status::text, monthly_contribution_cents FROM goals WHERE id = :id"),
            {"id": goal},
        ).one()
        assert tuple(row) == ("active", 50_000)

    return Case(
        "PATCH",
        f"/goals/{goal}",
        404,
        json={"status": "paused", "monthly_contribution_cents": 1},
        after=after,
    )


def update_own_goal_with_other_account(
    connection: Connection, client_as: Callable[[FixtureUser], TestClient]
) -> Case:
    """B's own goal pointed at A's account: the account is invisible, so 404."""
    account = a_account(connection)
    client = client_as(USER_B)
    result = client.post("/calc/emergency-fund", json=EMERGENCY_FUND_INPUTS).json()
    saved = client.post(
        "/decisions",
        json={"calculator": "emergency_fund", "inputs": EMERGENCY_FUND_INPUTS, "result": result},
    )
    goal = saved.json()["goal_id"]

    def after(conn: Connection) -> None:
        linked = conn.execute(
            text("SELECT account_id FROM goals WHERE id = :id"), {"id": goal}
        ).scalar_one()
        assert linked is None

    return Case("PATCH", f"/goals/{goal}", 404, json={"account_id": str(account)}, after=after)


def list_calendar(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    a_decision(client_as)

    def body(data: Any) -> None:
        assert data == []

    return Case("GET", "/calendar", 200, body=body)


def spending_summary(
    connection: Connection, client_as: Callable[[FixtureUser], TestClient]
) -> Case:
    account = a_account(connection)
    make_transaction(connection, USER_A.id, account, posted_at=dt.date(2026, 9, 10))
    make_pay_stub(
        connection,
        USER_A.id,
        a_document(connection, with_blob=False),
        pay_date=dt.date(2026, 9, 15),
    )

    def body(data: Any) -> None:
        assert (data["transaction_count"], data["paycheck_count"]) == (0, 0)

    return Case("GET", "/spending/summary?start=2026-09-01&end=2026-09-30", 200, body=body)


def get_cashflow(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    account = a_account(connection)
    make_transaction(connection, USER_A.id, account, posted_at=dt.date(2026, 9, 10))
    make_pay_stub(
        connection,
        USER_A.id,
        a_document(connection, with_blob=False),
        pay_date=dt.date(2026, 9, 15),
    )

    def body(data: Any) -> None:
        assert data["pay_stubs"] == []
        assert data["withholding"]["gross_cents"] == 0
        assert data["spending"]["transaction_count"] == 0

    return Case("GET", "/cashflow?start=2026-09-01&end=2026-09-30", 200, body=body)


def list_recurring(connection: Connection, client_as: Callable[[FixtureUser], TestClient]) -> Case:
    make_recurring_charge(connection, USER_A.id)

    def body(data: Any) -> None:
        assert data == []

    return Case("GET", "/recurring", 200, body=body)


def update_recurring(
    connection: Connection, client_as: Callable[[FixtureUser], TestClient]
) -> Case:
    charge = make_recurring_charge(connection, USER_A.id)

    def after(conn: Connection) -> None:
        row = conn.execute(
            text("SELECT merchant_clean, user_status FROM recurring_charges WHERE id = :id"),
            {"id": charge},
        ).one()
        assert tuple(row) == ("NETFLIX.COM", None)

    return Case(
        "PATCH",
        f"/recurring/{charge}",
        404,
        json={"user_status": "ignored", "merchant_clean": "Mine now"},
        after=after,
    )


ROUTE_CASES: dict[tuple[str, str], Builder] = {
    ("GET", "/cashflow"): get_cashflow,
    ("GET", "/recurring"): list_recurring,
    ("PATCH", "/recurring/{charge_id}"): update_recurring,
    ("POST", "/decisions"): save_decision,
    ("GET", "/decisions"): list_decisions,
    ("GET", "/decisions/{decision_id}"): get_decision,
    ("GET", "/decisions/{decision_id}/explanation"): get_explanation,
    ("POST", "/explain"): explain,
    ("GET", "/calendar"): list_calendar,
    ("GET", "/goals"): list_goals,
    ("PATCH", "/goals/{goal_id}"): update_goal,
    ("GET", "/spending/summary"): spending_summary,
    ("POST", "/docs"): upload_document,
    ("GET", "/docs"): list_documents,
    ("GET", "/docs/{document_id}"): get_document,
    ("POST", "/docs/{document_id}/extract"): extract_document,
    ("POST", "/docs/{document_id}/confirm"): confirm_document,
    ("GET", "/pay-stubs"): list_pay_stubs,
    ("GET", "/benefits-plans"): list_benefits_plans,
    ("GET", "/profile"): get_profile,
    ("PUT", "/profile"): put_profile,
    ("POST", "/sync/link-token"): link_token,
    ("POST", "/sync/items"): link_item,
    ("DELETE", "/sync/items/{item_id}"): delete_item,
    ("POST", "/sync/items/{item_id}/sync"): sync_item,
    ("GET", "/accounts"): list_accounts,
    ("PATCH", "/accounts/{account_id}"): update_account,
    ("POST", "/accounts/import"): import_csv,
    ("GET", "/transactions"): list_transactions,
    ("PATCH", "/transactions/{transaction_id}"): update_transaction,
    ("GET", "/jobs/{job_id}"): get_job,
}


def test_user_b_cannot_link_user_a_account_to_a_goal(
    db_connection: Connection,
    client_as: Callable[[FixtureUser], TestClient],
    user_a: FixtureUser,
    user_b: FixtureUser,
) -> None:
    case = update_own_goal_with_other_account(db_connection, client_as)
    response = client_as(user_b).request(case.method, case.path, json=case.json)
    assert response.status_code == 404, response.text
    assert response.json()["error"]["code"] == "not_found"
    assert case.after is not None
    case.after(db_connection)


def app_routes(app: FastAPI) -> set[tuple[str, str]]:
    """Every (method, path) the app serves, including routes hidden from OpenAPI.

    ``app.routes`` holds included routers as opaque entries; FastAPI's
    ``iter_route_contexts`` flattens them with their prefixes applied.
    """
    return {
        (method, str(context.path))
        for context in iter_route_contexts(app.routes)
        if isinstance(context.original_route, APIRoute)
        for method in context.methods or ()
    }


def test_every_route_has_a_cross_user_case(app: FastAPI) -> None:
    routes = app_routes(app) - EXEMPT
    assert set(ROUTE_CASES) == routes, (
        f"uncovered: {sorted(routes - set(ROUTE_CASES))}; "
        f"stale: {sorted(set(ROUTE_CASES) - routes)}"
    )


def test_exempt_routes_exist(app: FastAPI) -> None:
    assert app_routes(app) >= EXEMPT


@pytest.mark.parametrize("route", sorted(ROUTE_CASES), ids=lambda route: " ".join(route))
def test_user_b_cannot_reach_user_a_data(
    db_connection: Connection,
    client_as: Callable[[FixtureUser], TestClient],
    user_a: FixtureUser,
    user_b: FixtureUser,
    route: tuple[str, str],
) -> None:
    case = ROUTE_CASES[route](db_connection, client_as)
    response = client_as(user_b).request(
        case.method, case.path, json=case.json, data=case.form, files=case.files
    )
    assert response.status_code == case.status, response.text
    if case.status == 404:
        assert response.json()["error"]["code"] == "not_found"
    if case.body is not None:
        case.body(response.json())
    if case.after is not None:
        case.after(db_connection)
