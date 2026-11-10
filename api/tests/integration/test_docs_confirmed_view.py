"""What a confirmed document's row names, and its confirmed values on GET
/docs/{id} (spec 005 rules 22g and 22h, issue 243).

Before issue 243 every Link row said only "Pay stub", its status and when it
was uploaded, and a confirmed stub's values could not be seen again.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from db.enums import DocumentStatus
from tests.conftest import FixtureUser
from tests.integration.test_benefits import BRONZE, proposed
from tests.integration.test_docs_flow import PLAN
from tests.support.factories import make_document
from tests.support.pay_stub_copies import ACME, confirm, confirm_stub, document_of

Client = Callable[[FixtureUser], TestClient]


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def listed(client: TestClient) -> dict[uuid.UUID, dict[str, Any]]:
    response = client.get("/docs")
    assert response.status_code == 200, response.text
    return {uuid.UUID(doc["id"]): doc for doc in response.json()}


def names(doc: dict[str, Any]) -> tuple[Any, Any, Any]:
    return doc["employer_name"], doc["pay_date"], doc["plan_names"]


def test_a_confirmed_stub_names_its_employer_and_pay_date(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    acme = document_of(db_connection, confirm_stub(client, db_connection, user_a))
    other = document_of(
        db_connection,
        confirm_stub(
            client,
            db_connection,
            user_a,
            employer_name="Birch Lane Clinic",
            pay_date="2026-09-30",
            period_start="2026-09-16",
            period_end="2026-09-30",
        ),
    )
    reading = make_document(db_connection, user_a.id, status=DocumentStatus.PROPOSED, proposal={})

    docs = listed(client)
    assert names(docs[acme]) == ("Acme Corp", "2026-10-15", [])
    assert names(docs[other]) == ("Birch Lane Clinic", "2026-09-30", [])
    assert names(docs[reading]) == (None, None, [])
    assert names(client.get(f"/docs/{acme}").json()) == ("Acme Corp", "2026-10-15", [])


def test_the_confirm_response_names_the_stub(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = make_document(
        db_connection, user_a.id, status=DocumentStatus.PROPOSED, proposal={}
    )
    response = client.post(f"/docs/{document_id}/confirm", json={"pay_stub": ACME})
    assert response.status_code == 200, response.text
    assert names(response.json()["document"]) == ("Acme Corp", "2026-10-15", [])


def test_a_superseded_copy_still_names_its_stub(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = document_of(db_connection, confirm_stub(client, db_connection, user_a))
    confirm_stub(client, db_connection, user_a)
    doc = listed(client)[first]
    assert doc["superseded"] is True
    assert names(doc) == ("Acme Corp", "2026-10-15", [])


def test_a_stub_without_an_employer_names_only_its_pay_date(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = document_of(
        db_connection, confirm_stub(client, db_connection, user_a, employer_name=None)
    )
    assert names(listed(client)[document_id]) == (None, "2026-10-15", [])


def test_a_confirmed_summary_names_its_plans_in_order(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = proposed(client, empty_queue)
    response = client.post(
        f"/docs/{document_id}/confirm", json={"benefits": {"plans": [BRONZE, PLAN]}}
    )
    assert response.status_code == 200, response.text
    assert names(response.json()["document"]) == (None, None, ["Bronze HSA", "Gold PPO"])
    assert names(listed(client)[uuid.UUID(document_id)]) == (
        None,
        None,
        ["Bronze HSA", "Gold PPO"],
    )


def test_a_confirmed_stub_shows_its_values(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    stub_id = confirm_stub(client, db_connection, user_a)
    detail = client.get(f"/docs/{document_of(db_connection, stub_id)}").json()
    stub = detail["pay_stub"]
    assert stub["id"] == str(stub_id)
    assert {key: stub[key] for key in ACME} == ACME
    # Rule 24a's and 24b's computed fields, as GET /pay-stubs gives them.
    assert stub["annual_salary_cents"] == 270_833 * 24
    assert stub["retirement_contribution_pct"] == "0.00"
    assert detail["plans"] == []
    assert detail["proposal"] is None


def test_a_superseded_copy_still_shows_its_values(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = confirm_stub(client, db_connection, user_a)
    confirm_stub(client, db_connection, user_a)
    detail = client.get(f"/docs/{document_of(db_connection, first)}").json()
    assert detail["superseded"] is True
    assert detail["pay_stub"]["id"] == str(first)


def test_a_confirmed_summary_shows_its_plans(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = proposed(client, empty_queue)
    assert (
        client.post(
            f"/docs/{document_id}/confirm", json={"benefits": {"plans": [BRONZE, PLAN]}}
        ).status_code
        == 200
    )
    detail = client.get(f"/docs/{document_id}").json()
    assert [plan["name"] for plan in detail["plans"]] == ["Bronze HSA", "Gold PPO"]
    assert detail["plans"][0]["deductible_cents"] == 170_000
    assert detail["pay_stub"] is None


def test_a_document_in_review_shows_no_confirmed_values(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = make_document(
        db_connection, user_a.id, status=DocumentStatus.PROPOSED, proposal={}
    )
    detail = client.get(f"/docs/{document_id}").json()
    assert (detail["pay_stub"], detail["plans"]) == (None, [])


def test_a_replaced_document_still_shows_what_was_confirmed_from_it(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Spec 004 rule 26: what was confirmed from a replaced document stays."""
    client = client_as(user_a)
    stub_id = confirm_stub(client, db_connection, user_a)
    old = document_of(db_connection, stub_id)
    new = make_document(db_connection, user_a.id, status=DocumentStatus.PROPOSED, proposal={})
    db_connection.execute(
        text("UPDATE documents SET replaced_by_id = :new WHERE id = :old"),
        {"old": old, "new": new},
    )
    confirm(client, new, gross_cents=270_834, net_cents=199_605)
    detail = client.get(f"/docs/{old}").json()
    assert detail["replaced_by_id"] == str(new)
    assert detail["pay_stub"]["id"] == str(stub_id)
    assert names(detail) == ("Acme Corp", "2026-10-15", [])
