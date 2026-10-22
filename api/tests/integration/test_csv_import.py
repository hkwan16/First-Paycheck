"""POST /accounts/import (spec 010 part B, import examples and rules 16-23)."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, func, select, table, text

from app.routers import accounts
from sync.pipeline import SyncResult
from tests.conftest import FixtureUser
from tests.support.factories import make_account, make_item

Client = Callable[[FixtureUser], TestClient]

FILE_A = (
    "Date,Description,Amount,Balance\n"
    "2026-10-01,NETFLIX.COM,-15.49,984.51\n"
    '10/02/2026,ACME PAYROLL,"1,996.04","2,980.55"\n'
    "2026-10-03,BLUE BOTTLE COFFEE,(4.50),2976.05\n"
)
OVERLAP = (
    "Date,Description,Amount,Balance\n"
    "2026-10-03,BLUE BOTTLE COFFEE,(4.50),2976.05\n"
    "2026-10-04,SAFEWAY,-52.10,2923.95\n"
)


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def upload(client: TestClient, content: str | bytes, **form: str) -> Any:
    data = content.encode() if isinstance(content, str) else content
    return client.post(
        "/accounts/import", data=form, files={"file": ("export.csv", data, "text/csv")}
    )


def scalar(connection: Connection, sql: str, **params: Any) -> Any:
    return connection.execute(text(sql), params).scalar_one()


def transactions(connection: Connection, user: FixtureUser) -> list[tuple[str, int, str]]:
    rows = connection.execute(
        text(
            "SELECT posted_at::text, amount_cents, merchant_norm FROM transactions"
            " WHERE user_id = :u ORDER BY posted_at, amount_cents"
        ),
        {"u": user.id},
    )
    return [(posted_at, amount, merchant) for posted_at, amount, merchant in rows]


def test_import_creates_an_account(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)

    response = upload(client, FILE_A, kind="checking", name="Credit union")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["imported"] == 3
    account = body["account"]
    assert (account["name"], account["kind"], account["balance_cents"]) == (
        "Credit union",
        "checking",
        297605,
    )
    assert (account["mask"], account["provider"]) == (None, "csv")
    assert client.get("/accounts").json() == [account]
    assert transactions(empty_queue, user_a) == [
        ("2026-10-01", 1549, "netflix.com"),
        ("2026-10-02", -199604, "acme payroll"),
        ("2026-10-03", 450, "blue bottle coffee"),
    ]
    queued = empty_queue.execute(text("SELECT id, kind::text FROM jobs WHERE status = 'queued'"))
    jobs: dict[uuid.UUID, str] = dict(queued.all())
    assert jobs == {
        uuid.UUID(body["categorize_job_id"]): "categorize.run",
        uuid.UUID(body["recurring_job_id"]): "recurring.detect",
    }
    provider = scalar(
        empty_queue, "SELECT provider::text FROM sync_items WHERE user_id = :u", u=user_a.id
    )
    assert provider == "csv"


def test_default_name_and_institution(client_as: Client, user_a: FixtureUser) -> None:
    response = upload(client_as(user_a), FILE_A, kind="savings", institution_name="Local CU")
    assert response.status_code == 200, response.text
    account = response.json()["account"]
    assert (account["name"], account["institution_name"]) == ("Savings (CSV)", "Local CU")


def test_reimport_is_idempotent(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = upload(client, FILE_A, kind="checking").json()

    again = upload(client, FILE_A, account_id=first["account"]["id"])

    assert again.status_code == 200, again.text
    assert again.json()["imported"] == 3
    assert again.json()["account"]["id"] == first["account"]["id"]
    assert len(transactions(db_connection, user_a)) == 3
    assert scalar(db_connection, "SELECT count(*) FROM sync_items") == 1
    assert scalar(db_connection, "SELECT count(*) FROM accounts") == 1


def test_overlap_adds_only_new_rows(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = upload(client, FILE_A, kind="checking").json()

    response = upload(client, OVERLAP, account_id=first["account"]["id"])

    assert response.status_code == 200, response.text
    assert len(transactions(db_connection, user_a)) == 4
    assert response.json()["account"]["balance_cents"] == 292395


def test_categories_survive_a_reimport(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = upload(client, FILE_A, kind="checking").json()
    txn = scalar(db_connection, "SELECT id FROM transactions WHERE merchant_norm = 'netflix.com'")
    assert client.patch(f"/transactions/{txn}", json={"category": "subscriptions"}).is_success

    upload(client, FILE_A, account_id=first["account"]["id"])

    category = scalar(db_connection, "SELECT category FROM transactions WHERE id = :id", id=txn)
    assert category == "subscriptions"


def test_invalid_file_writes_nothing(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    response = upload(
        client_as(user_a),
        "Date,Description,Amount,Balance\n"
        "2026-10-01,NETFLIX.COM,-15.49,984.51\n"
        "2026-13-01,BAD DATE,-1.00\n"
        "2026-10-03,,-2.00\n"
        "2026-10-04,TOO PRECISE,-1.005\n",
        kind="checking",
    )

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "csv_invalid"
    assert error["message"] == "The CSV has 3 problems"
    assert [(item["row"], item["column"]) for item in error["details"]["errors"]] == [
        (3, "date"),
        (4, "description"),
        (5, "amount"),
    ]
    assert error["details"]["total"] == 3
    for name in ("sync_items", "accounts", "transactions", "jobs"):
        left = empty_queue.execute(select(func.count()).select_from(table(name))).scalar_one()
        assert left == 0, name


def test_plaid_account_is_refused(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    account = make_account(db_connection, user_a.id, make_item(db_connection, user_a.id))
    response = upload(client_as(user_a), FILE_A, account_id=str(account))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "not_csv_account"
    assert len(transactions(db_connection, user_a)) == 0


def test_unknown_account_is_404(client_as: Client, user_a: FixtureUser) -> None:
    response = upload(client_as(user_a), FILE_A, account_id=str(uuid.uuid4()))
    assert response.status_code == 404


@pytest.mark.parametrize(
    "form",
    [
        {"account_id": "00000000-0000-4000-8000-000000000001", "kind": "checking"},
        {"account_id": "00000000-0000-4000-8000-000000000001", "name": "X"},
        {"account_id": "00000000-0000-4000-8000-000000000001", "institution_name": "X"},
        {},
        {"kind": "checking", "name": "   "},
        {"kind": "checking", "name": "x" * 101},
        {"kind": "brokerage"},
        {"kind": "checking", "sign": "sideways"},
    ],
)
def test_inconsistent_fields(client_as: Client, user_a: FixtureUser, form: dict[str, str]) -> None:
    response = upload(client_as(user_a), FILE_A, **form)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"


def test_positive_is_out_option(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    response = upload(client_as(user_a), FILE_A, kind="checking", sign="positive_is_out")
    assert response.status_code == 200, response.text
    assert [amount for _, amount, _ in transactions(db_connection, user_a)] == [
        -1549,
        199604,
        -450,
    ]


def test_too_large_is_413(client_as: Client, user_a: FixtureUser) -> None:
    big = b"x" * (accounts.MAX_IMPORT_BYTES + 128 * 1024)
    response = upload(client_as(user_a), big, kind="checking")
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"


def test_a_file_just_over_the_limit_is_413_from_the_route(
    client_as: Client, user_a: FixtureUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Under the middleware's allowance for multipart overhead, over the file limit.
    monkeypatch.setattr(accounts, "MAX_IMPORT_BYTES", 100)
    response = upload(client_as(user_a), FILE_A, kind="checking")
    assert response.status_code == 413


def test_a_concurrent_import_is_409(
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Rule 21: the pipeline reports "stale" when another import moved the cursor.
    monkeypatch.setattr(accounts, "run_sync", lambda **_: SyncResult(outcome="stale"))
    response = upload(client_as(user_a), FILE_A, kind="checking")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "import_conflict"
    assert scalar(db_connection, "SELECT count(*) FROM sync_items") == 0
