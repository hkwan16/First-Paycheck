"""Migrations run forward and back on an empty database and match the models."""

from __future__ import annotations

from sqlalchemy import Engine, text

from app.db import current_alembic_revision
from tests.support.database import check, downgrade, head_revision, upgrade


def revision(engine: Engine) -> str | None:
    with engine.connect() as connection:
        return current_alembic_revision(connection)


def function_exists(engine: Engine, signature: str) -> bool:
    with engine.connect() as connection:
        return bool(
            connection.execute(
                text("SELECT to_regprocedure(:signature) IS NOT NULL"), {"signature": signature}
            ).scalar_one()
        )


def test_upgrade_downgrade_upgrade_then_check(scratch_database: tuple[str, Engine]) -> None:
    url, engine = scratch_database

    upgrade(url, "head")
    assert revision(engine) == head_revision()
    assert function_exists(engine, "public.current_user_id()")

    downgrade(url, "base")
    assert revision(engine) is None
    assert not function_exists(engine, "public.current_user_id()")

    upgrade(url, "head")
    assert revision(engine) == head_revision()
    check(url)  # raises when the models and the schema disagree


def test_0001_sets_up_the_app_api_role(scratch_database: tuple[str, Engine]) -> None:
    url, engine = scratch_database
    upgrade(url, "head")
    with engine.connect() as connection:
        role = connection.execute(
            text(
                "SELECT rolinherit, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_api'"
            )
        ).one()
        assert role == (False, False, False)
        can_switch = connection.execute(
            text("SELECT pg_has_role('app_api', 'authenticated', 'SET')")
        ).scalar_one()
        assert can_switch
        reads_version = connection.execute(
            text("SELECT has_table_privilege('app_api', 'public.alembic_version', 'SELECT')")
        ).scalar_one()
        assert reads_version


def test_0001_is_idempotent_when_the_role_already_exists(
    scratch_database: tuple[str, Engine],
) -> None:
    url, engine = scratch_database
    # app_api is cluster-wide and already exists from earlier runs; upgrading
    # twice from base must still succeed.
    upgrade(url, "head")
    downgrade(url, "base")
    upgrade(url, "head")
    assert revision(engine) == head_revision()


def test_current_user_id_reads_the_jwt_claims(scratch_database: tuple[str, Engine]) -> None:
    url, engine = scratch_database
    upgrade(url, "head")
    user_id = "6f1c2b8e-0000-4000-8000-000000000001"
    with engine.connect() as connection, connection.begin():
        connection.execute(
            text("SELECT set_config('request.jwt.claims', :claims, true)"),
            {"claims": f'{{"sub": "{user_id}"}}'},
        )
        assert str(connection.execute(text("SELECT public.current_user_id()")).scalar()) == user_id
