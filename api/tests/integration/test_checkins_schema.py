"""0005_checkins: recurring charges, check-ins, findings and the deferred keys (spec 001)."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import Connection, func, select, table, text
from sqlalchemy.exc import DataError, IntegrityError

from app.db import user_session_for
from db.enums import CHECKIN_ENUMS
from tests.conftest import FixtureUser

USER_TABLES = ("recurring_charges", "check_ins", "check_in_findings")


def as_user(connection: Connection, user: FixtureUser, sql: str, **params: Any) -> Any:
    with user_session_for(user.id, bind=connection) as session:
        return session.execute(text(sql), params)


def visible(connection: Connection, user: FixtureUser, name: str) -> int:
    with user_session_for(user.id, bind=connection) as session:
        return int(session.execute(select(func.count()).select_from(table(name))).scalar_one())


def recurring(connection: Connection, user: FixtureUser, **fields: Any) -> uuid.UUID:
    values = {
        "merchant_norm": "netflix.com",
        "merchant_clean": "Netflix",
        "cadence": "monthly",
        "typical": 1549,
        "first_seen": "2026-07-03",
        "last_seen": "2026-10-03",
        **fields,
    }
    row_id: uuid.UUID = as_user(
        connection,
        user,
        "INSERT INTO recurring_charges (user_id, merchant_norm, merchant_clean, cadence,"
        " typical_amount_cents, first_seen, last_seen)"
        " VALUES (:u, :merchant_norm, :merchant_clean, :cadence, :typical, :first_seen,"
        " :last_seen) RETURNING id",
        u=user.id,
        **values,
    ).scalar_one()
    return row_id


def check_in(
    connection: Connection,
    user: FixtureUser,
    period: str = "2026-10-01",
    triggered_by: str = "schedule",
) -> uuid.UUID:
    row_id: uuid.UUID = as_user(
        connection,
        user,
        "INSERT INTO check_ins (user_id, period, triggered_by) VALUES (:u, :p, :t) RETURNING id",
        u=user.id,
        p=period,
        t=triggered_by,
    ).scalar_one()
    return row_id


def finding(
    connection: Connection, user: FixtureUser, check_in_id: uuid.UUID, **fields: Any
) -> uuid.UUID:
    values = {
        "user_action": None,
        "user_action_at": None,
        "key": f"recurring_new:{uuid.uuid4()}",
        **fields,
    }
    row_id: uuid.UUID = as_user(
        connection,
        user,
        "INSERT INTO check_in_findings (user_id, check_in_id, kind, severity, key, payload,"
        " user_action, user_action_at)"
        " VALUES (:u, :c, 'recurring_new', 'info', :key, '{}', :user_action, :user_action_at)"
        " RETURNING id",
        u=user.id,
        c=check_in_id,
        **values,
    ).scalar_one()
    return row_id


def decision(
    connection: Connection,
    user: FixtureUser,
    check_in_id: uuid.UUID | None,
    calculator: str = "k401_match",
) -> None:
    as_user(
        connection,
        user,
        "INSERT INTO decisions (user_id, calculator, inputs, result, version, check_in_id)"
        " VALUES (:u, :calculator, '{}', '{}', 1, :c)",
        u=user.id,
        c=check_in_id,
        calculator=calculator,
    )


def explanation(connection: Connection, user: FixtureUser, finding_id: uuid.UUID) -> None:
    as_user(
        connection,
        user,
        "INSERT INTO explanations (user_id, finding_id, attempt, retries, concept, text,"
        " prompt_version, verified, fallback)"
        " VALUES (:u, :f, 1, 0, 'New charge', 'Body', 'explain/v1', true, false)",
        u=user.id,
        f=finding_id,
    )


def test_every_new_user_table_is_isolated(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    recurring(db_connection, user_a)
    finding(db_connection, user_a, check_in(db_connection, user_a))
    for name in USER_TABLES:
        assert visible(db_connection, user_a, name) == 1, name
        assert visible(db_connection, user_b, name) == 0, name


def test_rls_is_forced(db_connection: Connection) -> None:
    rows = db_connection.execute(
        text(
            "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class"
            " WHERE relname = ANY(:names) AND relnamespace = 'public'::regnamespace"
        ),
        {"names": list(USER_TABLES)},
    ).all()
    assert len(rows) == 3
    assert all(row[1] and row[2] for row in rows)


def test_python_enums_match_the_database(db_connection: Connection) -> None:
    for name, enum in CHECKIN_ENUMS.items():
        labels = db_connection.execute(
            text(
                "SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum"
                " WHERE enumtypid = to_regtype(:name)"
            ),
            {"name": name},
        ).scalar_one()
        assert labels == [member.value for member in enum], name


def test_recurring_charge_is_unique_per_merchant_and_cadence(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    recurring(db_connection, user_a)
    recurring(db_connection, user_a, cadence="yearly")
    recurring(db_connection, user_b)
    with pytest.raises(IntegrityError, match="uq_recurring_charges_user_id"):
        recurring(db_connection, user_a)


@pytest.mark.parametrize(
    ("fields", "constraint"),
    [
        ({"typical": 0}, "typical_positive"),
        ({"first_seen": "2026-10-04"}, "seen_in_order"),
        ({"merchant_norm": ""}, "merchant_norm_not_empty"),
        ({"merchant_clean": ""}, "merchant_clean_not_empty"),
    ],
)
def test_recurring_charge_checks(
    db_connection: Connection, user_a: FixtureUser, fields: dict[str, Any], constraint: str
) -> None:
    with pytest.raises(IntegrityError, match=constraint):
        recurring(db_connection, user_a, **fields)


def test_recurring_status_defaults_to_new(db_connection: Connection, user_a: FixtureUser) -> None:
    made = recurring(db_connection, user_a)
    row = db_connection.execute(
        text("SELECT status::text, user_status FROM recurring_charges WHERE id = :id"),
        {"id": made},
    ).one()
    assert tuple(row) == ("new", None)


def test_check_in_period_is_a_first_of_month(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    with pytest.raises(IntegrityError, match="period_first_of_month"):
        check_in(db_connection, user_a, period="2026-10-02")


def test_one_scheduled_check_in_per_month(db_connection: Connection, user_a: FixtureUser) -> None:
    check_in(db_connection, user_a)
    check_in(db_connection, user_a, triggered_by="sync")
    check_in(db_connection, user_a, triggered_by="sync")
    with pytest.raises(IntegrityError, match="uq_check_ins_scheduled_period"):
        check_in(db_connection, user_a)


def test_completed_at_matches_status(db_connection: Connection, user_a: FixtureUser) -> None:
    made = check_in(db_connection, user_a)
    with pytest.raises(IntegrityError, match="completed_when_done"):
        as_user(
            db_connection,
            user_a,
            "UPDATE check_ins SET status = 'completed' WHERE id = :id",
            id=made,
        )
    as_user(
        db_connection,
        user_a,
        "UPDATE check_ins SET status = 'completed', completed_at = now() WHERE id = :id",
        id=made,
    )


def test_finding_action_and_time_go_together(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    made = check_in(db_connection, user_a)
    with pytest.raises(IntegrityError, match="action_has_time"):
        finding(db_connection, user_a, made, user_action="dismissed")
    finding(db_connection, user_a, made, user_action="dismissed", user_action_at="2026-10-21")


def test_findings_cascade_with_their_check_in(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    made = check_in(db_connection, user_a)
    explanation(db_connection, user_a, finding(db_connection, user_a, made))
    as_user(db_connection, user_a, "DELETE FROM check_ins WHERE id = :id", id=made)
    assert visible(db_connection, user_a, "check_in_findings") == 0
    assert visible(db_connection, user_a, "explanations") == 0


def test_finding_key_is_unique_per_check_in(db_connection: Connection, user_a: FixtureUser) -> None:
    # Spec 015 rule 12 (migration 0012): one finding per key and check-in.
    first, second = check_in(db_connection, user_a), check_in(db_connection, user_a, "2026-11-01")
    finding(db_connection, user_a, first, key="pay_change:x")
    finding(db_connection, user_a, second, key="pay_change:x")
    with pytest.raises(IntegrityError, match="uq_check_in_findings_check_in_id_key"):
        finding(db_connection, user_a, first, key="pay_change:x")


def test_finding_key_is_not_empty(db_connection: Connection, user_a: FixtureUser) -> None:
    with pytest.raises(IntegrityError, match="key_not_empty"):
        finding(db_connection, user_a, check_in(db_connection, user_a), key="")


def test_finding_actions_are_done_and_dismissed(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    made = check_in(db_connection, user_a)
    finding(db_connection, user_a, made, user_action="done", user_action_at="2026-10-21")
    with pytest.raises(DataError, match="finding_action"):
        finding(db_connection, user_a, made, user_action="acted", user_action_at="2026-10-21")


def test_finding_cannot_join_another_users_check_in(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    made = check_in(db_connection, user_a)
    with pytest.raises(IntegrityError, match="fk_check_in_findings_check_in_id_check_ins"):
        finding(db_connection, user_b, made)


def test_decision_check_in_key(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    mine = check_in(db_connection, user_a)
    decision(db_connection, user_a, mine)
    with pytest.raises(IntegrityError, match="fk_decisions_check_in_id_check_ins"):
        decision(db_connection, user_b, mine)
    with pytest.raises(IntegrityError, match="fk_decisions_check_in_id_check_ins"):
        decision(db_connection, user_a, uuid.uuid4(), calculator="w4")


def test_explanation_finding_key(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    mine = finding(db_connection, user_a, check_in(db_connection, user_a))
    explanation(db_connection, user_a, mine)
    with pytest.raises(IntegrityError, match="fk_explanations_finding_id_check_in_findings"):
        explanation(db_connection, user_b, mine)


def test_account_deletion_removes_check_ins_and_their_decisions(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    made = check_in(db_connection, user_a)
    decision(db_connection, user_a, made)
    explanation(db_connection, user_a, finding(db_connection, user_a, made))
    recurring(db_connection, user_a)

    db_connection.execute(text("DELETE FROM auth.users WHERE id = :u"), {"u": user_a.id})

    for name in (*USER_TABLES, "decisions", "explanations"):
        rows = table(name)
        left = db_connection.execute(select(func.count()).select_from(rows)).scalar_one()
        assert left == 0, name
