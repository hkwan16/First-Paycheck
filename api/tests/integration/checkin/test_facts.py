"""What the check-in finders read about pay stubs (spec 015 facts table)."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.db import user_session_for
from checkin.facts import load_facts
from db.pay_stubs import paycheck_ids
from tests.conftest import FixtureUser
from tests.support.pay_stub_copies import LATE_OCTOBER, confirm_stub, replaced_late_october

Client = Callable[[FixtureUser], TestClient]
NOVEMBER = dt.date(2026, 11, 1)


def test_facts_read_current_stubs(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """The two newest stubs are current ones (spec 005 rule 22d, issue 190): a
    superseded copy is neither the newest stub nor the one before it, so the
    paycheck change finder never compares a stub with the copy it replaced."""
    client = client_as(user_a)
    _, corrected = replaced_late_october(client, db_connection, user_a)
    copy = confirm_stub(client, db_connection, user_a)

    with user_session_for(user_a.id, bind=db_connection) as session:
        facts = load_facts(session, NOVEMBER, NOVEMBER, paycheck_ids(session))

    assert [stub.id for stub in facts.pay_stubs] == [copy]
    assert corrected != copy


def test_facts_name_each_stub_by_its_first_copy(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Spec 015 Inputs, issue 194: a paycheck confirmed three times is named by the
    first copy, and a paycheck confirmed once by its own stub."""
    client = client_as(user_a)
    first = confirm_stub(client, db_connection, user_a)
    confirm_stub(client, db_connection, user_a)
    third = confirm_stub(client, db_connection, user_a)
    late = confirm_stub(client, db_connection, user_a, **LATE_OCTOBER)

    with user_session_for(user_a.id, bind=db_connection) as session:
        paychecks = paycheck_ids(session)
        facts = load_facts(session, NOVEMBER, NOVEMBER, paychecks)

    assert paychecks == {third: first, late: late}
    assert [(stub.id, stub.paycheck_id) for stub in facts.pay_stubs] == [
        (late, late),
        (third, first),
    ]
