"""The review draft: progress through a Confirm review kept with the document
until it is confirmed (spec 005 rules 23c-23e, issue 229). The cross-user case
is in ``tests/rls/test_cross_user.py``."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from ingest import store
from tests.conftest import FixtureUser
from tests.integration.test_docs_flow import CONFIRMED, extracted
from tests.integration.test_docs_replace import uploaded
from tests.support.factories import make_document

Client = Callable[[FixtureUser], TestClient]

# Gross pay edited and confirmed, 13 of the 14 fields confirmed: issue 229's review.
DRAFT: dict[str, Any] = {
    "fields": [
        {"key": key, "value": value, "confirmed": key != "net_cents"}
        for key, value in {**CONFIRMED, "gross_cents": 270_834}.items()
    ]
}


@pytest.fixture
def queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def proposed(client: TestClient, connection: Connection) -> str:
    document_id = uploaded(client)
    assert extracted(client, connection, document_id)["status"] == "proposed"
    return document_id


def stored_draft(connection: Connection, document_id: str) -> Any:
    return connection.execute(
        text("SELECT review_draft FROM documents WHERE id = :id"), {"id": document_id}
    ).scalar_one()


def test_a_saved_review_comes_back_with_the_document(
    queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = proposed(client, queue)
    assert client.get(f"/docs/{document_id}").json()["review"] is None

    response = client.put(f"/docs/{document_id}/review", json=DRAFT)
    assert response.status_code == 204, response.text
    detail = client.get(f"/docs/{document_id}").json()
    assert detail["review"] == DRAFT
    # The proposal is what was read; the draft never changes it.
    gross = next(f for f in detail["proposal"]["fields"] if f["key"] == "gross_cents")
    assert gross["value"] == 270_833

    # The next save replaces it whole.
    later = {"fields": [{"key": "gross_cents", "value": 270_833, "confirmed": False}]}
    assert client.put(f"/docs/{document_id}/review", json=later).status_code == 204
    assert client.get(f"/docs/{document_id}").json()["review"] == later


def test_a_draft_is_never_confirmed_data(
    queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Rule 23c: only confirm writes a stub, from its own body."""
    client = client_as(user_a)
    document_id = proposed(client, queue)
    assert client.put(f"/docs/{document_id}/review", json=DRAFT).status_code == 204
    assert client.get("/pay-stubs").json() == []

    confirmed = client.post(f"/docs/{document_id}/confirm", json={"pay_stub": CONFIRMED})
    assert confirmed.status_code == 200, confirmed.text
    [stub] = client.get("/pay-stubs").json()
    assert stub["gross_cents"] == 270_833
    # Rule 23d: confirming clears it.
    assert stored_draft(queue, document_id) is None
    assert client.get(f"/docs/{document_id}").json()["review"] is None
    refused = client.put(f"/docs/{document_id}/review", json=DRAFT)
    assert (refused.status_code, refused.json()["error"]["code"]) == (409, "document_confirmed")


def test_reading_again_clears_the_draft(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = make_document(
        db_connection,
        user_a.id,
        status="manual_entry_required",
        status_reason="no_model",
        proposal={"fields": [], "source_lines": [], "withheld_pages": [], "notes": None},
    )
    assert client.put(f"/docs/{document_id}/review", json=DRAFT).status_code == 204
    assert client.post(f"/docs/{document_id}/extract").status_code == 202
    assert stored_draft(db_connection, str(document_id)) is None
    refused = client.put(f"/docs/{document_id}/review", json=DRAFT)
    assert (refused.status_code, refused.json()["error"]["code"]) == (409, "document_not_ready")


def test_replacing_clears_the_draft(
    queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = proposed(client, queue)
    assert client.put(f"/docs/{document_id}/review", json=DRAFT).status_code == 204
    uploaded(client, replaces=document_id)
    assert stored_draft(queue, document_id) is None
    refused = client.put(f"/docs/{document_id}/review", json=DRAFT)
    assert (refused.status_code, refused.json()["error"]["code"]) == (409, "document_replaced")


def test_retention_clears_the_draft(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = make_document(
        db_connection,
        user_a.id,
        status="proposed",
        proposal={"fields": [], "source_lines": [], "withheld_pages": [], "notes": None},
    )
    assert client.put(f"/docs/{document_id}/review", json=DRAFT).status_code == 204
    later = dt.datetime.now(dt.UTC) + dt.timedelta(days=8)
    assert store.expire_unconfirmed(db_connection, now=later) == 1
    assert stored_draft(db_connection, str(document_id)) is None


@pytest.mark.parametrize(
    "status",
    ["uploaded", "extracting"],
)
def test_a_document_not_read_yet_has_no_review(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, status: str
) -> None:
    document_id = make_document(db_connection, user_a.id, status=status)
    refused = client_as(user_a).put(f"/docs/{document_id}/review", json=DRAFT)
    assert (refused.status_code, refused.json()["error"]["code"]) == (409, "document_not_ready")


def test_an_offer_letter_has_no_review(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    document_id = make_document(db_connection, user_a.id, type="offer_letter")
    refused = client_as(user_a).put(f"/docs/{document_id}/review", json=DRAFT)
    assert (refused.status_code, refused.json()["error"]["code"]) == (422, "wrong_document_type")


@pytest.mark.parametrize(
    "body",
    [
        {"fields": [{"key": "gross_cents", "value": 1, "confirmed": True}] * 2},
        {"fields": [{"key": "Gross Cents", "value": 1, "confirmed": True}]},
        {"fields": [{"key": "", "value": 1, "confirmed": True}]},
        {"fields": [{"key": "x" * 101, "value": 1, "confirmed": True}]},
        {"fields": [{"key": "gross_cents", "value": "x" * 201, "confirmed": True}]},
        {"fields": [{"key": "gross_cents", "value": 1.5, "confirmed": True}]},
        {"fields": [{"key": "gross_cents", "value": [1], "confirmed": True}]},
        {"fields": [{"key": "gross_cents", "value": 1}]},
        {"fields": [{"key": f"f{n}", "value": 1, "confirmed": True} for n in range(201)]},
        {"fields": [], "extra": 1},
    ],
)
def test_a_draft_that_breaks_the_shape_is_refused(
    queue: Connection, client_as: Client, user_a: FixtureUser, body: dict[str, Any]
) -> None:
    client = client_as(user_a)
    document_id = proposed(client, queue)
    response = client.put(f"/docs/{document_id}/review", json=body)
    assert response.status_code == 422, response.text
    assert client.get(f"/docs/{document_id}").json()["review"] is None


def test_benefits_keys_and_every_value_kind_are_accepted(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    document_id = make_document(
        db_connection,
        user_a.id,
        type="benefits",
        status="proposed",
        proposal={"plans": [], "source_lines": [], "withheld_pages": [], "notes": None},
    )
    body = {
        "fields": [
            {"key": "plans.0.name", "value": "Gold PPO", "confirmed": True},
            {"key": "plans.0.deductible_cents", "value": 50_000, "confirmed": False},
            {"key": "match_tiers.1.employer_pct", "value": "50.00", "confirmed": True},
            {"key": "vesting_years", "value": None, "confirmed": False},
        ]
    }
    client = client_as(user_a)
    assert client.put(f"/docs/{document_id}/review", json=body).status_code == 204
    assert client.get(f"/docs/{document_id}").json()["review"] == body
