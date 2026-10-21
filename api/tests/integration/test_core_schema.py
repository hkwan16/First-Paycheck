"""0002_core: constraints, cascades and the RLS exceptions of spec 001."""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import Connection, func, select, table, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.db import user_session_for
from db.enums import AccountRole, CategorySource
from tests.conftest import FixtureUser
from tests.support.factories import (
    make_account,
    make_holding,
    make_item,
    make_job,
    make_snapshot,
    make_transaction,
)


def seed_rule(connection: Connection, merchant_norm: str = "zz test streaming") -> uuid.UUID:
    """A seed row, written the way the seed loader writes it (privileged)."""
    rule_id: uuid.UUID = connection.execute(
        text(
            "INSERT INTO category_rules (user_id, merchant_norm, match, category, source)"
            " VALUES (NULL, :m, 'prefix', 'subscriptions', 'seed') RETURNING id"
        ),
        {"m": merchant_norm},
    ).scalar_one()
    return rule_id


def count(connection: Connection, user: FixtureUser, sql: str) -> int:
    with user_session_for(user.id, bind=connection) as session:
        return int(session.execute(text(sql)).scalar_one())


def rows(connection: Connection, user: FixtureUser, name: str) -> int:
    """How many rows of table ``name`` the user can see."""
    with user_session_for(user.id, bind=connection) as session:
        return int(session.execute(select(func.count()).select_from(table(name))).scalar_one())


def test_rls_owner_isolation(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    item = make_item(db_connection, user_a.id)
    account = make_account(db_connection, user_a.id, item)
    make_transaction(db_connection, user_a.id, account)

    for name in ("sync_items", "accounts", "transactions"):
        assert rows(db_connection, user_a, name) == 1
        assert rows(db_connection, user_b, name) == 0


def test_child_rows_cannot_point_at_another_users_parent(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    item = make_item(db_connection, user_a.id)
    # B forges an account under A's item: the composite foreign key
    # (sync_item_id, user_id) has no matching parent for B.
    with pytest.raises(IntegrityError, match="fk_accounts"):
        make_account(db_connection, user_b.id, item)


def test_seed_rules_visible_not_writable(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    rule = seed_rule(db_connection)
    with user_session_for(user_b.id, bind=db_connection) as session:
        assert (
            session.execute(
                text("SELECT category FROM category_rules WHERE id = :id"), {"id": rule}
            ).scalar_one()
            == "subscriptions"
        )
        updated = session.execute(
            text("UPDATE category_rules SET category = 'other' WHERE id = :id RETURNING id"),
            {"id": rule},
        ).all()
        assert updated == []
        deleted = session.execute(
            text("DELETE FROM category_rules WHERE id = :id RETURNING id"), {"id": rule}
        ).all()
        assert deleted == []


def test_users_cannot_write_seed_rows(db_connection: Connection, user_a: FixtureUser) -> None:
    with (
        pytest.raises(DBAPIError, match="row-level security"),
        user_session_for(user_a.id, bind=db_connection) as session,
    ):
        session.execute(
            text(
                "INSERT INTO category_rules (user_id, merchant_norm, match, category, source)"
                " VALUES (NULL, 'x', 'exact', 'other', 'seed')"
            )
        )


def test_user_rules_are_private(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(
            text(
                "INSERT INTO category_rules (user_id, merchant_norm, match, category, source)"
                " VALUES (:u, 'corner deli', 'exact', 'dining', 'user')"
            ),
            {"u": user_a.id},
        )
    owned = "SELECT count(*) FROM category_rules WHERE user_id IS NOT NULL"
    assert count(db_connection, user_a, owned) == 1
    assert count(db_connection, user_b, owned) == 0


def test_seed_rule_uniqueness_treats_null_owners_as_equal(db_connection: Connection) -> None:
    seed_rule(db_connection, "zz test unique")
    with pytest.raises(IntegrityError, match="uq_category_rules"):
        seed_rule(db_connection, "zz test unique")


def test_jobs_not_updatable_by_user(db_connection: Connection, user_a: FixtureUser) -> None:
    job = make_job(db_connection, user_a.id)
    # jobs grants authenticated SELECT and INSERT only (spec 001): status,
    # progress and results are written by jobs/queue.py on the privileged
    # connection.
    with (
        pytest.raises(DBAPIError, match="permission denied"),
        user_session_for(user_a.id, bind=db_connection) as session,
    ):
        session.execute(text("UPDATE jobs SET status = 'succeeded' WHERE id = :id"), {"id": job})
    status = db_connection.execute(
        text("SELECT status FROM jobs WHERE id = :id"), {"id": job}
    ).scalar_one()
    assert status == "queued"


def test_unlink_cascades(db_connection: Connection, user_a: FixtureUser) -> None:
    item = make_item(db_connection, user_a.id)
    account = make_account(db_connection, user_a.id, item)
    make_transaction(db_connection, user_a.id, account)
    make_snapshot(db_connection, user_a.id, account)
    make_holding(db_connection, user_a.id, account)

    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(text("DELETE FROM sync_items WHERE id = :id"), {"id": item})

    for name in ("accounts", "transactions", "balance_snapshots", "holdings"):
        assert rows(db_connection, user_a, name) == 0


def test_llm_confidence_only_with_llm_source(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    item = make_item(db_connection, user_a.id)
    account = make_account(db_connection, user_a.id, item)
    make_transaction(
        db_connection,
        user_a.id,
        account,
        category="dining",
        category_source=CategorySource.LLM,
        confidence=Decimal("0.812"),
    )
    with pytest.raises(IntegrityError, match="confidence"):
        make_transaction(
            db_connection,
            user_a.id,
            account,
            category="dining",
            category_source=CategorySource.RULE,
            confidence=Decimal("0.5"),
        )


def test_category_and_source_are_set_together(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    item = make_item(db_connection, user_a.id)
    account = make_account(db_connection, user_a.id, item)
    with pytest.raises(IntegrityError, match="category_source"):
        make_transaction(db_connection, user_a.id, account, category="dining")


def test_one_emergency_fund_account_per_user(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    item = make_item(db_connection, user_a.id)
    make_account(db_connection, user_a.id, item, role=AccountRole.EMERGENCY_FUND)
    with pytest.raises(IntegrityError, match="emergency"):
        make_account(db_connection, user_a.id, item, role=AccountRole.EMERGENCY_FUND)


def test_updated_at_is_maintained(db_connection: Connection, user_a: FixtureUser) -> None:
    item = make_item(db_connection, user_a.id)
    db_connection.execute(
        text("UPDATE sync_items SET updated_at = now() - interval '1 day' WHERE id = :id"),
        {"id": item},
    )
    db_connection.execute(
        text("UPDATE sync_items SET institution_name = 'Renamed' WHERE id = :id"), {"id": item}
    )
    fresh = db_connection.execute(
        text("SELECT updated_at > now() - interval '1 minute' FROM sync_items WHERE id = :id"),
        {"id": item},
    ).scalar_one()
    assert fresh


def test_system_jobs_have_no_owner(db_connection: Connection, user_a: FixtureUser) -> None:
    db_connection.execute(text("INSERT INTO jobs (kind) VALUES ('schedule.tick')"))
    with pytest.raises(IntegrityError, match="system"), db_connection.begin_nested():
        db_connection.execute(
            text("INSERT INTO jobs (user_id, kind) VALUES (:u, 'schedule.tick')"),
            {"u": user_a.id},
        )
    with pytest.raises(IntegrityError, match="system"), db_connection.begin_nested():
        db_connection.execute(text("INSERT INTO jobs (kind) VALUES ('categorize.run')"))


def test_job_idempotency_key_is_unique_per_user(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    insert = text(
        "INSERT INTO jobs (user_id, kind, idempotency_key) VALUES (:u, 'sync.initial', 'k')"
    )
    db_connection.execute(insert, {"u": user_a.id})
    db_connection.execute(insert, {"u": user_b.id})
    with pytest.raises(IntegrityError, match="idempotency"):
        db_connection.execute(insert, {"u": user_a.id})


def test_user_session_restores_the_callers_role(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    before = db_connection.execute(text("SELECT current_user")).scalar_one()
    with user_session_for(user_a.id, bind=db_connection) as session:
        assert session.execute(text("SELECT current_user")).scalar_one() == "authenticated"
    after = db_connection.execute(
        text("SELECT current_user, nullif(current_setting('request.jwt.claims', true), '')")
    ).one()
    assert tuple(after) == (before, None)
