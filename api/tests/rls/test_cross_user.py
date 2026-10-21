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
    make_transaction,
)

# Routes with no user data behind them, or no user at all.
EXEMPT = {("GET", "/health"), ("POST", "/sync/webhook")}


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


ROUTE_CASES: dict[tuple[str, str], Builder] = {
    ("POST", "/docs"): upload_document,
    ("GET", "/docs"): list_documents,
    ("GET", "/docs/{document_id}"): get_document,
    ("POST", "/docs/{document_id}/extract"): extract_document,
    ("POST", "/docs/{document_id}/confirm"): confirm_document,
    ("GET", "/pay-stubs"): list_pay_stubs,
    ("GET", "/profile"): get_profile,
    ("PUT", "/profile"): put_profile,
    ("POST", "/sync/link-token"): link_token,
    ("POST", "/sync/items"): link_item,
    ("DELETE", "/sync/items/{item_id}"): delete_item,
    ("POST", "/sync/items/{item_id}/sync"): sync_item,
    ("GET", "/accounts"): list_accounts,
    ("PATCH", "/accounts/{account_id}"): update_account,
    ("GET", "/transactions"): list_transactions,
    ("PATCH", "/transactions/{transaction_id}"): update_transaction,
    ("GET", "/jobs/{job_id}"): get_job,
}


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
