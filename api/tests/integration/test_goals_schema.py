"""0008_goals_and_birth_year: goal status, one emergency fund per user, the goal
calendar kinds (spec 011) and ``profiles.birth_year`` (spec 006 open question 2)."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.exc import IntegrityError

from app.db import user_session_for
from db.enums import GOAL_ENUMS, CalendarKind
from tests.conftest import FixtureUser


def as_user(connection: Connection, user: FixtureUser, sql: str, **params: Any) -> Any:
    with user_session_for(user.id, bind=connection) as session:
        return session.execute(text(sql), params)


def goal(connection: Connection, user: FixtureUser, **fields: Any) -> Any:
    values = {"kind": "emergency_fund", "status": "active", "reached_at": None, **fields}
    return as_user(
        connection,
        user,
        "INSERT INTO goals (user_id, kind, target_amount_cents, monthly_contribution_cents,"
        " status, reached_at) VALUES (:u, :kind, 600000, 50000, :status, :reached_at)"
        " RETURNING id, status::text",
        u=user.id,
        **values,
    ).one()


def labels(connection: Connection, name: str) -> list[str]:
    result: list[str] = connection.execute(
        text(
            "SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum"
            " WHERE enumtypid = to_regtype(:name)"
        ),
        {"name": name},
    ).scalar_one()
    return result


def test_python_enums_match_the_database(db_connection: Connection) -> None:
    for name, enum in GOAL_ENUMS.items():
        assert labels(db_connection, name) == [member.value for member in enum], name
    assert labels(db_connection, "calendar_kind")[-2:] == [
        CalendarKind.GOAL_CONTRIBUTION.value,
        CalendarKind.GOAL_REVIEW.value,
    ]


def test_a_new_goal_is_active(db_connection: Connection, user_a: FixtureUser) -> None:
    row = as_user(
        db_connection,
        user_a,
        "INSERT INTO goals (user_id, kind, target_amount_cents, monthly_contribution_cents)"
        " VALUES (:u, 'emergency_fund', 600000, 50000) RETURNING status::text, reached_at",
        u=user_a.id,
    ).one()
    assert tuple(row) == ("active", None)


def test_reached_goes_with_reached_at(db_connection: Connection, user_a: FixtureUser) -> None:
    with pytest.raises(IntegrityError, match="reached_has_time"):
        goal(db_connection, user_a, status="reached")
    with pytest.raises(IntegrityError, match="reached_has_time"):
        goal(db_connection, user_a, reached_at="2026-10-21T00:00:00Z")
    assert goal(db_connection, user_a, status="reached", reached_at="2026-10-21T00:00:00Z")


def test_one_emergency_fund_goal_per_user(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    goal(db_connection, user_a)
    goal(db_connection, user_b)
    goal(db_connection, user_a, kind="custom")
    goal(db_connection, user_a, kind="custom")
    with pytest.raises(IntegrityError, match="uq_goals_user_emergency_fund"):
        goal(db_connection, user_a)


def test_goal_calendar_kinds_are_accepted(db_connection: Connection, user_a: FixtureUser) -> None:
    for kind in ("goal_contribution", "goal_review"):
        as_user(
            db_connection,
            user_a,
            "INSERT INTO calendar_events (user_id, kind, title, due_at)"
            " VALUES (:u, :kind, 'Goal', '2026-10-30')",
            u=user_a.id,
            kind=kind,
        )


@pytest.mark.parametrize(("year", "ok"), [(1899, False), (1900, True), (2008, True)])
def test_birth_year_is_checked(
    db_connection: Connection, user_a: FixtureUser, year: int, ok: bool
) -> None:
    def insert() -> None:
        as_user(
            db_connection,
            user_a,
            "INSERT INTO profiles (user_id, birth_year) VALUES (:u, :year)",
            u=user_a.id,
            year=year,
        )

    if ok:
        insert()
    else:
        with pytest.raises(IntegrityError, match="birth_year_after_1900"):
            insert()
