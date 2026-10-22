"""The per-user limits on write routes (``app/ratelimit.py:WRITE_ROUTE_POLICIES``).

Each limited route is called once with no requests counted (it succeeds and
counts one) and once with its window already full (429 ``rate_limited`` with
``Retry-After``, and nothing written). ``POST /docs`` and ``POST /explain``
have their own fuller tests in ``test_docs_flow.py`` and ``test_explain.py``.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app import ratelimit
from app.db import user_session_for
from app.deps import get_now
from tests.conftest import FixtureUser
from tests.support.factories import make_document, make_item
from tests.support.november import K401_INPUTS

NOW = dt.datetime(2026, 10, 21, 15, 20, tzinfo=dt.UTC)
Client = Callable[[FixtureUser], TestClient]


@dataclass
class Call:
    method: str
    path: str
    status: int
    json: dict[str, Any] | None = None
    form: dict[str, str] | None = None
    files: dict[str, tuple[str, bytes, str]] | None = None


Setup = Callable[[Connection, FixtureUser, TestClient], Call]


def extract(connection: Connection, user: FixtureUser, client: TestClient) -> Call:
    document = make_document(connection, user.id)
    return Call("POST", f"/docs/{document}/extract", 202)


def decision(connection: Connection, user: FixtureUser, client: TestClient) -> Call:
    result = client.post("/calc/401k-match", json=K401_INPUTS).json()
    body = {"calculator": "k401_match", "inputs": K401_INPUTS, "result": result}
    return Call("POST", "/decisions", 201, json=body)


def plan_export(connection: Connection, user: FixtureUser, client: TestClient) -> Call:
    return Call("POST", "/plan/export", 202)


def check_in_now(connection: Connection, user: FixtureUser, client: TestClient) -> Call:
    return Call("POST", "/check-ins", 202)


def link_token(connection: Connection, user: FixtureUser, client: TestClient) -> Call:
    return Call("POST", "/sync/link-token", 200)


def link_item(connection: Connection, user: FixtureUser, client: TestClient) -> Call:
    return Call("POST", "/sync/items", 201, json={"public_token": "public-sandbox-limits"})


def manual_sync(connection: Connection, user: FixtureUser, client: TestClient) -> Call:
    return Call("POST", f"/sync/items/{make_item(connection, user.id)}/sync", 202)


def csv_import(connection: Connection, user: FixtureUser, client: TestClient) -> Call:
    csv = b"Date,Description,Amount\n2026-10-01,Coffee,-4.50\n"
    return Call(
        "POST",
        "/accounts/import",
        200,
        form={"kind": "checking"},
        files={"file": ("a.csv", csv, "text/csv")},
    )


CASES: dict[str, tuple[ratelimit.Limit, Setup]] = {
    "extract_document": (ratelimit.EXTRACTIONS, extract),
    "save_decision": (ratelimit.DECISIONS, decision),
    "export_plan": (ratelimit.PLAN_EXPORTS, plan_export),
    "check_in_now": (ratelimit.CHECK_INS, check_in_now),
    "create_link_token": (ratelimit.LINK_TOKENS, link_token),
    "link_item": (ratelimit.LINKS, link_item),
    "sync_item": (ratelimit.MANUAL_SYNCS, manual_sync),
    "import_csv": (ratelimit.CSV_IMPORTS, csv_import),
}
TESTED_ELSEWHERE = {"upload_document", "explain"}


def test_every_limited_route_is_tested() -> None:
    limited = {
        name
        for name, policy in ratelimit.WRITE_ROUTE_POLICIES.items()
        if isinstance(policy, ratelimit.Limit)
    }
    assert limited == set(CASES) | TESTED_ELSEWHERE
    for name, (limit, _) in CASES.items():
        assert ratelimit.WRITE_ROUTE_POLICIES[name] == limit


@pytest.fixture
def frozen(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_now] = lambda: NOW
    return app


def send(client: TestClient, call: Call) -> Any:
    return client.request(call.method, call.path, json=call.json, data=call.form, files=call.files)


def counted(connection: Connection, user: FixtureUser, limit: ratelimit.Limit) -> int:
    return int(
        connection.execute(
            text(
                "SELECT coalesce(sum(count), 0) FROM rate_limit_counters"
                " WHERE user_id = :u AND bucket = :b"
            ),
            {"u": user.id, "b": limit.bucket},
        ).scalar_one()
    )


@pytest.mark.parametrize("name", sorted(CASES))
def test_a_request_under_the_limit_counts_one(
    name: str, frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    limit, setup = CASES[name]
    client = client_as(user_a)
    call = setup(db_connection, user_a, client)

    response = send(client, call)

    assert response.status_code == call.status, response.text
    assert counted(db_connection, user_a, limit) == 1


@pytest.mark.parametrize("name", sorted(CASES))
def test_a_full_window_is_429(
    name: str, frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    limit, setup = CASES[name]
    client = client_as(user_a)
    call = setup(db_connection, user_a, client)
    with user_session_for(user_a.id, bind=db_connection) as session:
        for _ in range(limit.limit):
            ratelimit.consume(session, user_a.id, limit, now=NOW)
    jobs_before = db_connection.execute(text("SELECT count(*) FROM jobs")).scalar_one()

    response = send(client, call)

    assert response.status_code == 429, response.text
    assert response.json()["error"]["code"] == "rate_limited"
    assert int(response.headers["Retry-After"]) > 0
    assert counted(db_connection, user_a, limit) == limit.limit
    assert db_connection.execute(text("SELECT count(*) FROM jobs")).scalar_one() == jobs_before
