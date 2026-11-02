"""One current stub per paycheck: a newer confirm supersedes (spec 005 rules
22a-22e, hand-worked examples "One stub per paycheck", issue 190).

Before issue 190, confirming the same stub again stored a second row that every
reader counted: two copies of the Acme stub made October read "2 pay stubs" at
$5,416.66 gross and $595.52 federal tax.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.db import user_session_for
from tests.conftest import FixtureUser
from tests.support.factories import MOCKUP_STUB, make_document, make_pay_stub
from tests.support.pay_stub_copies import (
    confirm,
    confirm_stub,
    document_of,
    proposed_document,
    replace,
)

Client = Callable[[FixtureUser], TestClient]
OCTOBER = {"start": "2026-10-01", "end": "2026-10-31"}


def superseded_by(connection: Connection, stub_id: uuid.UUID) -> uuid.UUID | None:
    value = connection.execute(
        text("SELECT superseded_by_id FROM pay_stubs WHERE id = :id"), {"id": stub_id}
    ).scalar_one()
    return None if value is None else uuid.UUID(str(value))


def listed(client: TestClient) -> list[uuid.UUID]:
    response = client.get("/pay-stubs")
    assert response.status_code == 200, response.text
    return [uuid.UUID(stub["id"]) for stub in response.json()]


def october(client: TestClient) -> dict[str, Any]:
    """October's paycheck count, gross and federal tax, from GET /cashflow."""
    response = client.get("/cashflow", params=OCTOBER)
    assert response.status_code == 200, response.text
    body = response.json()
    lines = {line["key"]: line["amount_cents"] for line in body["withholding"]["lines"]}
    return {
        "paycheck_count": body["withholding"]["paycheck_count"],
        "summary_paycheck_count": body["spending"]["paycheck_count"],
        "gross_cents": body["withholding"]["gross_cents"],
        "federal_cents": lines["federal_withholding"],
    }


ONE_ACME = {
    "paycheck_count": 1,
    "summary_paycheck_count": 1,
    "gross_cents": 270_833,
    "federal_cents": 29_776,
}


def test_second_copy_supersedes_the_first(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = confirm_stub(client, db_connection, user_a)
    second = confirm_stub(client, db_connection, user_a)

    assert superseded_by(db_connection, first) == second
    assert superseded_by(db_connection, second) is None
    assert listed(client) == [second]
    # Not 541,666 and 59,552: the copy counts once.
    assert october(client) == ONE_ACME


def test_third_copy_supersedes_the_second(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = confirm_stub(client, db_connection, user_a)
    second = confirm_stub(client, db_connection, user_a)
    third = confirm_stub(client, db_connection, user_a)

    assert superseded_by(db_connection, first) == second
    assert superseded_by(db_connection, second) == third
    assert listed(client) == [third]
    assert october(client) == ONE_ACME


def test_employer_compares_without_spacing_or_case(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = confirm_stub(client, db_connection, user_a, employer_name="Acme Corp")
    second = confirm_stub(client, db_connection, user_a, employer_name=" ACME  corp ")

    assert superseded_by(db_connection, first) == second
    assert october(client) == ONE_ACME


def test_another_employer_is_another_paycheck(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    acme = confirm_stub(client, db_connection, user_a)
    beta = confirm_stub(client, db_connection, user_a, employer_name="Beta LLC")

    assert superseded_by(db_connection, acme) is None
    assert set(listed(client)) == {acme, beta}
    assert october(client) == {
        "paycheck_count": 2,
        "summary_paycheck_count": 2,
        "gross_cents": 541_666,
        "federal_cents": 59_552,
    }


def test_punctuation_names_another_employer(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = confirm_stub(client, db_connection, user_a, employer_name="Acme Corp")
    confirm_stub(client, db_connection, user_a, employer_name="Acme Corp.")

    assert superseded_by(db_connection, first) is None


def test_off_cycle_check_is_another_paycheck(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    regular = confirm_stub(client, db_connection, user_a)
    bonus = confirm_stub(client, db_connection, user_a, pay_date="2026-10-20")

    assert superseded_by(db_connection, regular) is None
    assert set(listed(client)) == {regular, bonus}
    assert october(client)["paycheck_count"] == 2


def test_a_missing_employer_matches_a_missing_employer(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = confirm_stub(client, db_connection, user_a, employer_name=None)
    second = confirm_stub(client, db_connection, user_a, employer_name=None)

    assert superseded_by(db_connection, first) == second


def test_confirming_a_replacement_supersedes_the_replaced_stub(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    typo = confirm_stub(client, db_connection, user_a, pay_date="2026-10-14")
    document = proposed_document(db_connection, user_a)
    replace(db_connection, user_a, document_of(db_connection, typo), document)
    # Until the replacement is confirmed, the stub confirmed before still counts.
    assert listed(client) == [typo]

    corrected = confirm(client, document)

    # Different pay dates, so not the same paycheck: Replace supersedes it.
    assert superseded_by(db_connection, typo) == corrected
    assert listed(client) == [corrected]
    assert october(client) == ONE_ACME


def test_replacement_chain_reaches_the_last_confirmed_stub(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = confirm_stub(client, db_connection, user_a)
    never_confirmed = make_document(db_connection, user_a.id, with_blob=False)
    replace(db_connection, user_a, document_of(db_connection, first), never_confirmed)
    last = proposed_document(db_connection, user_a)
    replace(db_connection, user_a, never_confirmed, last)

    third = confirm(client, last, pay_date="2026-10-14")

    assert superseded_by(db_connection, first) == third
    assert listed(client) == [third]
    assert october(client) == ONE_ACME


def test_other_users_copy_is_untouched(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    theirs = confirm_stub(client_as(user_b), db_connection, user_b)
    mine = confirm_stub(client_as(user_a), db_connection, user_a)

    assert superseded_by(db_connection, theirs) is None
    assert superseded_by(db_connection, mine) is None
    assert listed(client_as(user_a)) == [mine]
    assert listed(client_as(user_b)) == [theirs]
    assert october(client_as(user_a)) == ONE_ACME
    assert october(client_as(user_b)) == ONE_ACME


FINAL = "confirmed pay stub never changes"


@pytest.mark.parametrize(
    ("statement", "refusal"),
    [
        # Un-superseding a copy would make it count again; the index refuses
        # first while its successor is current.
        ("UPDATE pay_stubs SET superseded_by_id = NULL WHERE id = :first", "uq_pay_stubs_current"),
        # The trigger refuses it when nothing else holds the paycheck.
        ("UPDATE pay_stubs SET superseded_by_id = NULL WHERE id = :replaced", FINAL),
        # A superseded stub is never superseded a second time.
        ("UPDATE pay_stubs SET superseded_by_id = :third WHERE id = :first", FINAL),
        # A stub is only ever superseded by another one.
        ("UPDATE pay_stubs SET superseded_by_id = id WHERE id = :third", "superseded_by_other"),
    ],
)
def test_superseded_stub_is_final(
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    statement: str,
    refusal: str,
) -> None:
    client = client_as(user_a)
    ids = {
        "first": confirm_stub(client, db_connection, user_a),
        "second": confirm_stub(client, db_connection, user_a),
        "third": confirm_stub(client, db_connection, user_a, employer_name="Beta LLC"),
    }
    # Gamma's stub, replaced by an upload confirmed with another pay date.
    ids["replaced"] = confirm_stub(client, db_connection, user_a, employer_name="Gamma Inc")
    document = proposed_document(db_connection, user_a)
    replace(db_connection, user_a, document_of(db_connection, ids["replaced"]), document)
    confirm(client, document, employer_name="Gamma Inc", pay_date="2026-10-14")

    with (
        pytest.raises(DBAPIError, match=refusal),
        user_session_for(user_a.id, bind=db_connection) as session,
    ):
        session.execute(text(statement), ids)

    assert superseded_by(db_connection, ids["first"]) == ids["second"]
    assert superseded_by(db_connection, ids["third"]) is None


def test_only_superseded_by_id_may_be_updated(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """``authenticated`` holds UPDATE on that one column; the trigger guards it."""
    stub = confirm_stub(client_as(user_a), db_connection, user_a)
    with (
        pytest.raises(DBAPIError, match="permission denied"),
        user_session_for(user_a.id, bind=db_connection) as session,
    ):
        session.execute(text("UPDATE pay_stubs SET net_cents = 0 WHERE id = :id"), {"id": stub})


def test_two_current_stubs_of_one_paycheck_are_refused(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    make_pay_stub(db_connection, user_a.id, make_document(db_connection, user_a.id))
    with pytest.raises(IntegrityError, match="uq_pay_stubs_current_paycheck"):
        make_pay_stub(
            db_connection,
            user_a.id,
            make_document(db_connection, user_a.id),
            employer_name=f"  {str(MOCKUP_STUB['employer_name']).upper()} ",
        )
