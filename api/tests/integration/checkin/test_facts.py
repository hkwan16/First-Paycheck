"""What the check-in finders read about pay stubs (spec 015 facts table)."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.db import user_session_for
from checkin.facts import load_facts
from db.enums import CalculatorKind
from db.pay_stubs import paycheck_ids
from tests.conftest import FixtureUser
from tests.support.factories import make_decision
from tests.support.pay_stub_copies import LATE_OCTOBER, confirm_stub, replaced_late_october

Client = Callable[[FixtureUser], TestClient]
NOVEMBER = dt.date(2026, 11, 1)
EASTERN = ZoneInfo("America/New_York")


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
        facts = load_facts(session, NOVEMBER, NOVEMBER, paycheck_ids(session), zone=EASTERN)

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
        facts = load_facts(session, NOVEMBER, NOVEMBER, paychecks, zone=EASTERN)

    assert paychecks == {third: first, late: late}
    assert [(stub.id, stub.paycheck_id) for stub in facts.pay_stubs] == [
        (late, late),
        (third, first),
    ]


def test_decided_on_is_the_persons_day(db_connection: Connection, user_a: FixtureUser) -> None:
    """Spec 019 rule 3, example 22: a decision saved at 21:00 PST on November 14
    was decided on the 14th for the person, though it was the 15th in UTC."""
    make_decision(
        db_connection,
        user_a.id,
        CalculatorKind.K401_MATCH,
        {"contribution_pct": "4"},
        created_at=dt.datetime(2026, 11, 15, 5, 0, tzinfo=dt.UTC),
    )
    with user_session_for(user_a.id, bind=db_connection) as session:
        pacific = load_facts(session, NOVEMBER, NOVEMBER, {}, zone=ZoneInfo("America/Los_Angeles"))
        eastern = load_facts(session, NOVEMBER, NOVEMBER, {}, zone=EASTERN)
    assert pacific.k401 is not None
    assert eastern.k401 is not None
    assert (pacific.k401.decided_on, eastern.k401.decided_on) == (
        dt.date(2026, 11, 14),
        dt.date(2026, 11, 15),
    )
