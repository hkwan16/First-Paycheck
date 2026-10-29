"""0003_documents: constraints, generated columns and row-level security (specs 001, 004)."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest
from sqlalchemy import Connection, func, select, table, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.db import user_session_for
from db.enums import CORE_ENUMS, DOCUMENT_ENUMS
from tests.conftest import FixtureUser
from tests.support.factories import make_document, make_pay_stub

USER_TABLES = (
    "documents",
    "document_blobs",
    "pay_stubs",
    "benefits_plans",
    "benefits_chunks",
    "rate_limit_counters",
)


def visible(connection: Connection, user: FixtureUser, name: str) -> int:
    with user_session_for(user.id, bind=connection) as session:
        return int(session.execute(select(func.count()).select_from(table(name))).scalar_one())


def as_user(connection: Connection, user: FixtureUser, sql: str, **params: Any) -> Any:
    with user_session_for(user.id, bind=connection) as session:
        return session.execute(text(sql), params)


def insert_plan(connection: Connection, user: FixtureUser, document_id: uuid.UUID | None) -> None:
    as_user(
        connection,
        user,
        "INSERT INTO benefits_plans (user_id, document_id, name, kind, premium_per_period_cents,"
        " deductible_cents, oop_max_cents, coinsurance_pct, employer_hsa_cents)"
        " VALUES (:u, :d, 'Gold PPO', 'ppo', 6250, 50000, 300000, 20, 0)",
        u=user.id,
        d=document_id,
    )


def insert_chunk(
    connection: Connection, user: FixtureUser, document_id: uuid.UUID, body: str
) -> None:
    as_user(
        connection,
        user,
        "INSERT INTO benefits_chunks (user_id, document_id, chunk_index, text)"
        " VALUES (:u, :d, 0, :t)",
        u=user.id,
        d=document_id,
        t=body,
    )


def test_every_new_table_is_isolated_per_user(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    stub_doc = make_document(db_connection, user_a.id)
    make_pay_stub(db_connection, user_a.id, stub_doc)
    benefits = make_document(db_connection, user_a.id, type="benefits")
    insert_plan(db_connection, user_a, benefits)
    insert_chunk(db_connection, user_a, benefits, "Deductible applies before coinsurance.")
    as_user(
        db_connection,
        user_a,
        "INSERT INTO rate_limit_counters (user_id, bucket, window_start, count)"
        " VALUES (:u, 'docs.upload', date_trunc('hour', now()), 1)",
        u=user_a.id,
    )

    for name in USER_TABLES:
        assert visible(db_connection, user_a, name) >= 1, name
        assert visible(db_connection, user_b, name) == 0, name


def test_rls_is_forced_on_every_new_table(db_connection: Connection) -> None:
    rows = db_connection.execute(
        text(
            "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class"
            " WHERE relname = ANY(:names) AND relnamespace = 'public'::regnamespace"
        ),
        {"names": list(USER_TABLES)},
    ).all()
    assert {row[0] for row in rows} == set(USER_TABLES)
    assert all(row[1] and row[2] for row in rows)


def test_pay_stub_must_balance(db_connection: Connection, user_a: FixtureUser) -> None:
    document = make_document(db_connection, user_a.id)
    with pytest.raises(IntegrityError, match="pay_stub_balances"):
        make_pay_stub(db_connection, user_a.id, document, net_cents=199_606)


def test_tax_year_comes_from_pay_date(db_connection: Connection, user_a: FixtureUser) -> None:
    document = make_document(db_connection, user_a.id)
    stub = make_pay_stub(db_connection, user_a.id, document, pay_date=dt.date(2027, 1, 2))
    year = db_connection.execute(
        text("SELECT tax_year FROM pay_stubs WHERE id = :id"), {"id": stub}
    ).scalar_one()
    assert year == 2027


def test_one_pay_stub_per_document(db_connection: Connection, user_a: FixtureUser) -> None:
    document = make_document(db_connection, user_a.id)
    make_pay_stub(db_connection, user_a.id, document)
    with pytest.raises(IntegrityError, match="uq_pay_stubs_document_id"):
        make_pay_stub(db_connection, user_a.id, document)


def test_pay_stub_cannot_point_at_another_users_document(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    document = make_document(db_connection, user_a.id)
    with pytest.raises(IntegrityError, match="fk_pay_stubs_document_id_documents"):
        make_pay_stub(db_connection, user_b.id, document)


def test_status_reason_only_for_failed_and_manual_entry(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    document = make_document(db_connection, user_a.id)
    with pytest.raises(IntegrityError, match="status_reason_when_stuck"):
        as_user(
            db_connection,
            user_a,
            "UPDATE documents SET status = 'failed' WHERE id = :id",
            id=document,
        )
    with pytest.raises(IntegrityError, match="status_reason_when_stuck"):
        as_user(
            db_connection,
            user_a,
            "UPDATE documents SET status_reason = 'refused' WHERE id = :id",
            id=document,
        )


def test_confirmed_at_set_exactly_when_confirmed(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    document = make_document(db_connection, user_a.id)
    with pytest.raises(IntegrityError, match="confirmed_at_when_confirmed"):
        as_user(
            db_connection,
            user_a,
            "UPDATE documents SET status = 'confirmed' WHERE id = :id",
            id=document,
        )


def test_blob_size_matches_its_bytes(db_connection: Connection, user_a: FixtureUser) -> None:
    document = make_document(db_connection, user_a.id, with_blob=False)
    with pytest.raises(IntegrityError, match="size_matches_bytes"):
        as_user(
            db_connection,
            user_a,
            "INSERT INTO document_blobs (document_id, user_id, bytes, content_type, size_bytes)"
            " VALUES (:d, :u, '\\x255044462d'::bytea, 'application/pdf', 99)",
            d=document,
            u=user_a.id,
        )


REPLACE = "UPDATE documents SET replaced_by_id = :by, deleted_at = now() WHERE id = :id"


def test_a_document_cannot_replace_itself(db_connection: Connection, user_a: FixtureUser) -> None:
    document = make_document(db_connection, user_a.id, with_blob=False)
    with pytest.raises(IntegrityError, match="ck_documents_replaced_by_other"):
        as_user(db_connection, user_a, REPLACE, by=document, id=document)


def test_a_replaced_document_has_no_file(db_connection: Connection, user_a: FixtureUser) -> None:
    old = make_document(db_connection, user_a.id, with_blob=False)
    new = make_document(db_connection, user_a.id)
    with pytest.raises(IntegrityError, match="ck_documents_replaced_means_deleted"):
        as_user(
            db_connection,
            user_a,
            "UPDATE documents SET replaced_by_id = :by WHERE id = :id",
            by=new,
            id=old,
        )


def test_a_replacement_is_the_same_users(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    old = make_document(db_connection, user_a.id, with_blob=False)
    other = make_document(db_connection, user_b.id)
    with pytest.raises(IntegrityError, match="fk_documents_replaced_by_id_documents"):
        db_connection.execute(text(REPLACE), {"by": other, "id": old})


def test_a_document_replaces_at_most_one(db_connection: Connection, user_a: FixtureUser) -> None:
    first = make_document(db_connection, user_a.id, with_blob=False)
    second = make_document(db_connection, user_a.id, with_blob=False)
    new = make_document(db_connection, user_a.id)
    as_user(db_connection, user_a, REPLACE, by=new, id=first)
    with pytest.raises(IntegrityError, match="uq_documents_replaced_by_id"):
        as_user(db_connection, user_a, REPLACE, by=new, id=second)


def test_deleting_a_user_removes_replaced_documents(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    old = make_document(db_connection, user_a.id, with_blob=False)
    new = make_document(db_connection, user_a.id)
    as_user(db_connection, user_a, REPLACE, by=new, id=old)
    db_connection.execute(text("DELETE FROM auth.users WHERE id = :id"), {"id": user_a.id})
    remaining = db_connection.execute(
        text("SELECT count(*) FROM documents WHERE user_id = :u"), {"u": user_a.id}
    ).scalar_one()
    assert remaining == 0


def test_users_cannot_delete_documents(db_connection: Connection, user_a: FixtureUser) -> None:
    document = make_document(db_connection, user_a.id)
    with pytest.raises(DBAPIError, match="permission denied"):
        as_user(db_connection, user_a, "DELETE FROM documents WHERE id = :id", id=document)


def test_benefits_chunks_are_searchable(db_connection: Connection, user_a: FixtureUser) -> None:
    document = make_document(db_connection, user_a.id, type="benefits")
    insert_chunk(
        db_connection, user_a, document, "The HSA employer contribution is deposited quarterly."
    )
    with user_session_for(user_a.id, bind=db_connection) as session:
        hits = session.execute(
            text(
                "SELECT chunk_index FROM benefits_chunks"
                " WHERE search @@ plainto_tsquery('english', 'employer contributions')"
            )
        ).all()
    assert [hit[0] for hit in hits] == [0]


def test_benefits_plan_deductible_within_oop_max(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    with pytest.raises(IntegrityError, match="deductible_within_oop_max"):
        as_user(
            db_connection,
            user_a,
            "INSERT INTO benefits_plans (user_id, name, kind, premium_per_period_cents,"
            " deductible_cents, oop_max_cents, coinsurance_pct)"
            " VALUES (:u, 'Odd HMO', 'hmo', 0, 500000, 100000, 10)",
            u=user_a.id,
        )


def test_deleting_a_user_removes_their_documents(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    document = make_document(db_connection, user_a.id)
    make_pay_stub(db_connection, user_a.id, document)
    db_connection.execute(text("DELETE FROM auth.users WHERE id = :id"), {"id": user_a.id})
    remaining = db_connection.execute(
        text(
            "SELECT (SELECT count(*) FROM documents WHERE user_id = :u)"
            " + (SELECT count(*) FROM document_blobs WHERE user_id = :u)"
            " + (SELECT count(*) FROM pay_stubs WHERE user_id = :u)"
        ),
        {"u": user_a.id},
    ).scalar_one()
    assert remaining == 0


def test_python_enums_match_the_database(db_connection: Connection) -> None:
    for name, enum in {**CORE_ENUMS, **DOCUMENT_ENUMS}.items():
        labels = db_connection.execute(
            text(
                "SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum"
                " WHERE enumtypid = to_regtype(:name)"
            ),
            {"name": name},
        ).scalar_one()
        assert labels == [member.value for member in enum], name
