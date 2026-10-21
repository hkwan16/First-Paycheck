"""0004_decisions: goals, calendar events, explanations and IRS citations (specs 001, 007, 008)."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import Connection, func, select, table, text
from sqlalchemy.exc import DBAPIError, IntegrityError, ProgrammingError

from app.db import user_session_for
from db.enums import DECISION_ENUMS
from tests.conftest import FixtureUser
from tests.support.factories import make_account, make_item

USER_TABLES = ("decisions", "goals", "calendar_events", "explanations")


def as_user(connection: Connection, user: FixtureUser, sql: str, **params: Any) -> Any:
    with user_session_for(user.id, bind=connection) as session:
        return session.execute(text(sql), params)


def decision(connection: Connection, user: FixtureUser) -> uuid.UUID:
    row_id: uuid.UUID = as_user(
        connection,
        user,
        "INSERT INTO decisions (user_id, calculator, inputs, result, version)"
        " VALUES (:u, 'k401_match', '{}', '{}', 1) RETURNING id",
        u=user.id,
    ).scalar_one()
    return row_id


def explanation(
    connection: Connection, user: FixtureUser, decision_id: uuid.UUID | None, **fields: Any
) -> None:
    values = {
        "attempt": 1,
        "retries": 0,
        "verified": True,
        "fallback": False,
        "finding_id": None,
        **fields,
    }
    as_user(
        connection,
        user,
        "INSERT INTO explanations (user_id, decision_id, finding_id, attempt, retries, concept,"
        " text, prompt_version, verified, fallback)"
        " VALUES (:u, :d, :finding_id, :attempt, :retries, 'Match', 'Body', 'explain/v1',"
        " :verified, :fallback)",
        u=user.id,
        d=decision_id,
        **values,
    )


def visible(connection: Connection, user: FixtureUser, name: str) -> int:
    with user_session_for(user.id, bind=connection) as session:
        return int(session.execute(select(func.count()).select_from(table(name))).scalar_one())


def test_every_new_user_table_is_isolated(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    made = decision(db_connection, user_a)
    explanation(db_connection, user_a, made)
    as_user(
        db_connection,
        user_a,
        "INSERT INTO goals (user_id, kind, target_amount_cents, monthly_contribution_cents,"
        " decision_id) VALUES (:u, 'emergency_fund', 600000, 50000, :d)",
        u=user_a.id,
        d=made,
    )
    as_user(
        db_connection,
        user_a,
        "INSERT INTO calendar_events (user_id, kind, title, due_at, decision_id)"
        " VALUES (:u, 'election_check', 'Check', '2026-10-30', :d)",
        u=user_a.id,
        d=made,
    )
    for name in USER_TABLES:
        assert visible(db_connection, user_a, name) == 1, name
        assert visible(db_connection, user_b, name) == 0, name
    assert visible(db_connection, user_b, "current_decisions") == 0
    assert visible(db_connection, user_a, "current_decisions") == 1


def test_rls_is_forced(db_connection: Connection) -> None:
    rows = db_connection.execute(
        text(
            "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class"
            " WHERE relname = ANY(:names) AND relnamespace = 'public'::regnamespace"
        ),
        {"names": [*USER_TABLES, "irs_citations"]},
    ).all()
    assert len(rows) == 5
    assert all(row[1] and row[2] for row in rows)


def test_python_enums_match_the_database(db_connection: Connection) -> None:
    for name, enum in DECISION_ENUMS.items():
        labels = db_connection.execute(
            text(
                "SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum"
                " WHERE enumtypid = to_regtype(:name)"
            ),
            {"name": name},
        ).scalar_one()
        assert labels == [member.value for member in enum], name


def test_explanations_are_append_only(db_connection: Connection, user_a: FixtureUser) -> None:
    explanation(db_connection, user_a, decision(db_connection, user_a))
    for statement in ("UPDATE explanations SET verified = false", "DELETE FROM explanations"):
        with pytest.raises(ProgrammingError, match="permission denied"):
            as_user(db_connection, user_a, statement)


def test_explanation_needs_exactly_one_subject(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    with pytest.raises(IntegrityError, match="one_subject"):
        explanation(db_connection, user_a, None)
    made = decision(db_connection, user_a)
    with pytest.raises(IntegrityError, match="one_subject"):
        explanation(db_connection, user_a, made, finding_id=uuid.uuid4())


def test_explanation_cannot_be_verified_and_fallback(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    with pytest.raises(IntegrityError, match="verified_or_fallback"):
        explanation(
            db_connection, user_a, decision(db_connection, user_a), verified=True, fallback=True
        )


@pytest.mark.parametrize(("field", "value"), [("attempt", 4), ("attempt", 0), ("retries", 2)])
def test_explanation_attempt_bounds(
    db_connection: Connection, user_a: FixtureUser, field: str, value: int
) -> None:
    with pytest.raises(IntegrityError):
        explanation(db_connection, user_a, decision(db_connection, user_a), **{field: value})


def test_explanation_cannot_point_at_another_users_decision(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    made = decision(db_connection, user_a)
    with pytest.raises(IntegrityError, match="fk_explanations_decision_id_decisions"):
        explanation(db_connection, user_b, made)


def test_explanations_keep_insert_order_in_one_transaction(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    made = decision(db_connection, user_a)
    for attempt in (1, 2):
        explanation(db_connection, user_a, made, attempt=attempt, verified=False)
    times = db_connection.execute(
        text("SELECT created_at FROM explanations ORDER BY attempt")
    ).scalars()
    first, second = list(times)
    assert first < second


def test_goal_survives_unlinking_its_account(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    item = make_item(db_connection, user_a.id)
    account = make_account(db_connection, user_a.id, item)
    as_user(
        db_connection,
        user_a,
        "INSERT INTO goals (user_id, kind, target_amount_cents, monthly_contribution_cents,"
        " account_id) VALUES (:u, 'emergency_fund', 600000, 50000, :a)",
        u=user_a.id,
        a=account,
    )
    as_user(db_connection, user_a, "DELETE FROM sync_items WHERE id = :i", i=item)
    rows = db_connection.execute(text("SELECT user_id, account_id FROM goals")).all()
    assert rows == [(user_a.id, None)]


def test_goal_amounts_are_checked(db_connection: Connection, user_a: FixtureUser) -> None:
    with pytest.raises(IntegrityError, match="target_positive"):
        as_user(
            db_connection,
            user_a,
            "INSERT INTO goals (user_id, kind, target_amount_cents, monthly_contribution_cents)"
            " VALUES (:u, 'custom', 0, 0)",
            u=user_a.id,
        )


def test_irs_citations_are_readable_not_writable(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    db_connection.execute(
        text(
            "INSERT INTO irs_citations (calculator, key, title, url, passage, source, tax_year,"
            " verified_on) VALUES ('k401_match', 'k401.test', 'T', 'https://www.irs.gov/x',"
            " 'P', 'S', 2099, '2026-10-21')"
        )
    )
    assert visible(db_connection, user_a, "irs_citations") >= 1
    with pytest.raises(ProgrammingError, match="permission denied"):
        as_user(db_connection, user_a, "UPDATE irs_citations SET title = 'x'")
    with pytest.raises(ProgrammingError, match="permission denied"):
        as_user(
            db_connection,
            user_a,
            "INSERT INTO irs_citations (calculator, key, title, url, passage, source, tax_year,"
            " verified_on) VALUES ('k401_match', 'k', 'T', 'https://x', 'P', 'S', 2099,"
            " '2026-10-21')",
        )


def test_irs_citation_url_must_be_https(db_connection: Connection) -> None:
    with pytest.raises(IntegrityError, match="url_https"):
        db_connection.execute(
            text(
                "INSERT INTO irs_citations (calculator, key, title, url, passage, source,"
                " tax_year, verified_on) VALUES ('k401_match', 'k401.x', 'T', 'http://irs.gov',"
                " 'P', 'S', 2099, '2026-10-21')"
            )
        )


def test_calendar_title_not_empty(db_connection: Connection, user_a: FixtureUser) -> None:
    with pytest.raises(DBAPIError, match="title_not_empty"):
        as_user(
            db_connection,
            user_a,
            "INSERT INTO calendar_events (user_id, kind, title, due_at)"
            " VALUES (:u, 'tax_season', '', '2027-04-15')",
            u=user_a.id,
        )
