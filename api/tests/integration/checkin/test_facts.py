"""What the check-in finders read about pay stubs (spec 015 facts table)."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.db import user_session_for
from checkin.facts import load_facts
from tests.conftest import FixtureUser
from tests.support.pay_stub_copies import confirm_stub, replaced_late_october

Client = Callable[[FixtureUser], TestClient]
NOVEMBER = dt.date(2026, 11, 1)


def test_facts_read_current_stubs(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """The two newest stubs are current ones (spec 005 rule 22d, issue 190): a
    superseded copy is neither the newest stub nor the one before it, so the
    pay change and deduction change finders never compare a stub with the copy
    it replaced."""
    client = client_as(user_a)
    _, corrected = replaced_late_october(client, db_connection, user_a)
    copy = confirm_stub(client, db_connection, user_a)

    with user_session_for(user_a.id, bind=db_connection) as session:
        facts = load_facts(session, NOVEMBER, NOVEMBER)

    assert [stub.id for stub in facts.pay_stubs] == [copy]
    assert corrected != copy
