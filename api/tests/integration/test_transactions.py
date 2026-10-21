"""GET and PATCH /transactions (spec 003 rules 13-18)."""

from __future__ import annotations

import base64
import datetime as dt
import uuid
from collections.abc import Callable
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from db.enums import CategorySource
from tests.conftest import FixtureUser
from tests.support.factories import make_account, make_item, make_transaction

Client = Callable[[FixtureUser], TestClient]


@pytest.fixture
def account(db_connection: Connection, user_a: FixtureUser) -> uuid.UUID:
    return make_account(db_connection, user_a.id, make_item(db_connection, user_a.id))


def day(n: int) -> dt.date:
    return dt.date(2026, 10, n)


def ids(response: Any) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


def test_pages_in_posted_order_with_an_opaque_cursor(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, account: uuid.UUID
) -> None:
    made = [
        make_transaction(db_connection, user_a.id, account, posted_at=day(n))
        for n in (1, 3, 3, 2, 5)
    ]
    # posted_at DESC, then id DESC among the two on day 3.
    on_day_3 = sorted([made[1], made[2]], reverse=True)
    expected = [str(t) for t in [made[4], *on_day_3, made[3], made[0]]]
    client = client_as(user_a)

    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        params: dict[str, Any] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        response = client.get("/transactions", params=params)
        seen += ids(response)
        pages += 1
        cursor = response.json()["next_cursor"]
        if cursor is None:
            break
    assert seen == expected
    assert pages == 3


def test_transaction_shape(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, account: uuid.UUID
) -> None:
    txn = make_transaction(
        db_connection,
        user_a.id,
        account,
        merchant_raw="NETFLIX.COM #1234",
        amount_cents=1599,
        posted_at=day(4),
        category="subscriptions",
        category_source=CategorySource.LLM,
        confidence=Decimal("0.875"),
    )
    [item] = client_as(user_a).get("/transactions").json()["items"]
    assert item == {
        "id": str(txn),
        "account_id": str(account),
        "posted_at": "2026-10-04",
        "amount_cents": 1599,
        "merchant_raw": "NETFLIX.COM #1234",
        "merchant_clean": None,
        "merchant_norm": "netflix.com",
        "category": "subscriptions",
        "category_source": "llm",
        "confidence": 0.875,
        "pending": False,
    }


def test_filters(
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    user_b: FixtureUser,
    account: uuid.UUID,
) -> None:
    other = make_account(db_connection, user_a.id, make_item(db_connection, user_a.id))
    rule = make_transaction(
        db_connection,
        user_a.id,
        account,
        posted_at=day(1),
        category="groceries",
        category_source=CategorySource.RULE,
    )
    user = make_transaction(
        db_connection,
        user_a.id,
        account,
        posted_at=day(2),
        category="dining",
        category_source=CategorySource.USER,
    )
    sure = make_transaction(
        db_connection,
        user_a.id,
        other,
        posted_at=day(3),
        category="dining",
        category_source=CategorySource.LLM,
        confidence=Decimal("0.700"),
    )
    unsure = make_transaction(
        db_connection,
        user_a.id,
        other,
        posted_at=day(4),
        category="shopping",
        category_source=CategorySource.LLM,
        confidence=Decimal("0.620"),
    )
    blank = make_transaction(db_connection, user_a.id, account, posted_at=day(5))
    make_transaction(
        db_connection,
        user_b.id,
        make_account(db_connection, user_b.id, make_item(db_connection, user_b.id)),
    )
    client = client_as(user_a)

    def get(**params: Any) -> list[str]:
        return ids(client.get("/transactions", params=params))

    assert get() == [str(t) for t in (blank, unsure, sure, user, rule)]
    assert get(account_id=str(other)) == [str(unsure), str(sure)]
    assert get(start="2026-10-02", end="2026-10-04") == [str(unsure), str(sure), str(user)]
    assert get(start="2026-10-04") == [str(blank), str(unsure)]
    assert get(end="2026-10-01") == [str(rule)]
    assert get(category="dining") == [str(sure), str(user)]
    assert get(min_confidence=0.7) == [str(sure), str(user), str(rule)]
    assert get(min_confidence=0) == [str(unsure), str(sure), str(user), str(rule)]
    assert get(category="dining", account_id=str(account)) == [str(user)]


@pytest.mark.parametrize(
    "params",
    [
        {"start": "2026-10-05", "end": "2026-10-04"},
        {"limit": 0},
        {"limit": 201},
        {"min_confidence": 1.5},
        {"category": "snacks"},
        {"cursor": "not-a-cursor"},
        {"cursor": base64.urlsafe_b64encode(b'{"p": "2026-10-01"}').decode()},
        {"account_id": "nope"},
    ],
)
def test_invalid_queries_are_422(
    client_as: Client, user_a: FixtureUser, params: dict[str, Any]
) -> None:
    response = client_as(user_a).get("/transactions", params=params)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_patch_writes_a_rule_and_relabels(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, account: uuid.UUID
) -> None:
    t1 = make_transaction(
        db_connection,
        user_a.id,
        account,
        merchant_raw="NETFLIX.COM",
        category="entertainment",
        category_source=CategorySource.LLM,
        confidence=Decimal("0.62"),
    )
    t2 = make_transaction(
        db_connection,
        user_a.id,
        account,
        merchant_raw="NETFLIX.COM",
        category="entertainment",
        category_source=CategorySource.RULE,
    )

    response = client_as(user_a).patch(f"/transactions/{t1}", json={"category": "subscriptions"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["transaction"]["id"] == str(t1)
    assert (
        body["transaction"]["category"],
        body["transaction"]["category_source"],
        body["transaction"]["confidence"],
    ) == ("subscriptions", "user", None)
    assert body["rule"] == {"merchant_norm": "netflix.com", "category": "subscriptions"}
    assert body["relabeled"] == 1
    sibling = db_connection.execute(
        text("SELECT category, category_source::text FROM transactions WHERE id = :id"),
        {"id": t2},
    ).one()
    assert tuple(sibling) == ("subscriptions", "rule")


def test_patch_validation_and_404(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, account: uuid.UUID
) -> None:
    txn = make_transaction(db_connection, user_a.id, account)
    client = client_as(user_a)
    assert client.patch(f"/transactions/{txn}", json={"category": "snacks"}).status_code == 422
    assert client.patch(f"/transactions/{txn}", json={}).status_code == 422
    missing = client.patch(f"/transactions/{uuid.uuid4()}", json={"category": "dining"})
    assert missing.status_code == 404
