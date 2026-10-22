"""0013_plan_export_job: the ``plan.export`` job kind and ``plan_exports`` (spec 016
rules 14-17), and ``export/store.py``."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import pytest
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.db import user_session_for
from db.enums import JobKind
from export import store
from tests.conftest import FixtureUser
from tests.support.database import alembic_config, downgrade, upgrade
from tests.support.factories import make_job

REVISION = "0013_plan_export_job"
PDF = b"%PDF-1.7 plan"
CREATED = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)


def as_user(connection: Connection, user: FixtureUser, sql: str, **params: Any) -> Any:
    with user_session_for(user.id, bind=connection) as session:
        return session.execute(text(sql), params)


def export_job(connection: Connection, user: FixtureUser) -> uuid.UUID:
    return make_job(connection, user.id, kind=JobKind.PLAN_EXPORT)


def put(connection: Connection, user: FixtureUser, job_id: uuid.UUID, data: bytes = PDF) -> bool:
    with user_session_for(user.id, bind=connection) as session:
        return store.put(session, job_id=job_id, user_id=user.id, data=data, created_at=CREATED)


def test_job_kind_has_plan_export(db_connection: Connection) -> None:
    labels = db_connection.execute(text("SELECT enum_range(NULL::job_kind)::text[]")).scalar_one()
    assert labels[-1] == "plan.export"
    assert labels == [kind.value for kind in JobKind]


def test_rls_is_forced_and_users_may_only_read_and_insert(db_connection: Connection) -> None:
    forced = db_connection.execute(
        text(
            "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class"
            " WHERE relname = 'plan_exports' AND relnamespace = 'public'::regnamespace"
        )
    ).scalar_one()
    assert forced
    grants = db_connection.execute(
        text(
            "SELECT array_agg(privilege_type::text ORDER BY privilege_type) FROM"
            " information_schema.role_table_grants"
            " WHERE table_name = 'plan_exports' AND grantee = :role"
        ),
        {"role": "authenticated"},
    ).scalar_one()
    assert grants == ["INSERT", "SELECT"]
    for role in ("anon", "PUBLIC"):
        assert not db_connection.execute(
            text(
                "SELECT count(*) FROM information_schema.role_table_grants"
                " WHERE table_name = 'plan_exports' AND grantee = :role"
            ),
            {"role": role},
        ).scalar_one()


def test_store_round_trip_is_per_user(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    job = export_job(db_connection, user_a)
    assert put(db_connection, user_a, job) is True
    with user_session_for(user_a.id, bind=db_connection) as session:
        stored = store.get(session, job)
    assert stored == store.StoredExport(
        data=PDF, content_type="application/pdf", created_at=CREATED
    )
    with user_session_for(user_b.id, bind=db_connection) as session:
        assert store.get(session, job) is None


def test_a_second_put_for_the_same_job_keeps_the_first(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    job = export_job(db_connection, user_a)
    assert put(db_connection, user_a, job) is True
    assert put(db_connection, user_a, job, data=b"%PDF-1.7 other") is False
    with user_session_for(user_a.id, bind=db_connection) as session:
        stored = store.get(session, job)
    assert stored is not None
    assert stored.data == PDF


def test_an_export_cannot_point_at_another_users_job(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    job = export_job(db_connection, user_a)
    with pytest.raises(IntegrityError):
        put(db_connection, user_b, job)


def test_users_cannot_change_or_delete_exports(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    job = export_job(db_connection, user_a)
    put(db_connection, user_a, job)
    for sql in (
        "UPDATE plan_exports SET content_type = 'application/pdf' WHERE job_id = :id",
        "DELETE FROM plan_exports WHERE job_id = :id",
    ):
        with pytest.raises(DBAPIError, match="permission denied"):
            as_user(db_connection, user_a, sql, id=job)


@pytest.mark.parametrize(
    ("data", "content_type"),
    [(b"", "application/pdf"), (PDF, "text/html")],
    ids=["empty", "not_a_pdf"],
)
def test_only_non_empty_pdfs(
    db_connection: Connection, user_a: FixtureUser, data: bytes, content_type: str
) -> None:
    job = export_job(db_connection, user_a)
    with pytest.raises(IntegrityError):
        as_user(
            db_connection,
            user_a,
            "INSERT INTO plan_exports (job_id, user_id, bytes, content_type)"
            " VALUES (:j, :u, :b, :c)",
            j=job,
            u=user_a.id,
            b=data,
            c=content_type,
        )


def test_deleting_the_job_removes_its_export(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    job = export_job(db_connection, user_a)
    put(db_connection, user_a, job)
    db_connection.execute(text("DELETE FROM jobs WHERE id = :id"), {"id": job})
    assert not db_connection.execute(text("SELECT count(*) FROM plan_exports")).scalar_one()


def test_downgrade_removes_the_kind_its_jobs_and_the_table(
    scratch_database: tuple[str, Engine],
) -> None:
    url, engine = scratch_database
    previous = ScriptDirectory.from_config(alembic_config()).get_revision(REVISION).down_revision
    assert isinstance(previous, str)
    upgrade(url, "head")
    user = "00000000-0000-4000-8000-0000000000d9"
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": user})
        for kind in ("plan.export", "categorize.run"):
            connection.execute(
                text("INSERT INTO jobs (user_id, kind) VALUES (:u, :kind)"),
                {"u": user, "kind": kind},
            )
    downgrade(url, previous)
    with engine.connect() as connection:
        labels = connection.execute(text("SELECT enum_range(NULL::job_kind)::text[]")).scalar_one()
        kinds = connection.execute(text("SELECT kind::text FROM jobs")).scalars()
        table = connection.execute(text("SELECT to_regclass('public.plan_exports')")).scalar()
        assert "plan.export" not in labels
        assert list(kinds) == ["categorize.run"]
        assert table is None
    upgrade(url, "head")
