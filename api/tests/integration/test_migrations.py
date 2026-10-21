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


def tables_granted_to(engine: Engine, *roles: str) -> list[str]:
    with engine.connect() as connection:
        return list(
            connection.execute(
                text(
                    "SELECT DISTINCT table_name FROM information_schema.role_table_grants "
                    "WHERE table_schema = 'public' AND grantee = ANY(:roles) ORDER BY 1"
                ),
                {"roles": list(roles)},
            ).scalars()
        )


def functions_executable_by(engine: Engine, role: str) -> list[str]:
    with engine.connect() as connection:
        return list(
            connection.execute(
                text(
                    "SELECT p.oid::regprocedure::text FROM pg_proc p "
                    "JOIN pg_namespace n ON n.oid = p.pronamespace "
                    "WHERE n.nspname = 'public' "
                    "AND has_function_privilege(:role, p.oid, 'EXECUTE') ORDER BY 1"
                ),
                {"role": role},
            ).scalars()
        )


def test_supabase_api_roles_hold_only_the_grants_migrations_intend(
    scratch_database: tuple[str, Engine],
) -> None:
    """The shim copies Supabase's default grants; every object must revoke them.

    ``anon`` is the Data API role behind the publishable key, so it may hold
    nothing in ``public``. ``authenticated`` keeps the per-table grants from
    ``enable_rls`` and the two functions its own queries run, and nothing else.
    """
    url, engine = scratch_database
    upgrade(url, "head")

    assert tables_granted_to(engine, "anon", "PUBLIC") == []
    assert functions_executable_by(engine, "anon") == []

    assert "alembic_version" not in tables_granted_to(engine, "authenticated")
    assert "alembic_version" in tables_granted_to(engine, "app_api")
    assert functions_executable_by(engine, "authenticated") == [
        "current_user_id()",
        "decision_is_mine(uuid)",
        "set_updated_at()",
    ]


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


def test_0008_numbers_existing_plans_in_list_order(scratch_database: tuple[str, Engine]) -> None:
    url, engine = scratch_database
    upgrade(url, "0005_checkins")
    user = "00000000-0000-4000-8000-0000000000c1"
    document = "00000000-0000-4000-8000-0000000000d1"
    plan = text(
        "INSERT INTO benefits_plans (user_id, document_id, name, kind,"
        " premium_per_period_cents, deductible_cents, oop_max_cents, coinsurance_pct,"
        " created_at) VALUES (:u, :d, :name, 'ppo', 0, 0, 0, 10, :at)"
    )
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": user})
        connection.execute(
            text(
                "INSERT INTO documents (id, user_id, type, content_type, size_bytes)"
                " VALUES (:d, :u, 'benefits', 'application/pdf', 1)"
            ),
            {"d": document, "u": user},
        )
        for name, at, owner in [
            ("Second", "2026-10-02", document),
            ("First", "2026-10-01", document),
            ("By hand", "2026-10-03", None),
        ]:
            connection.execute(plan, {"u": user, "d": owner, "name": name, "at": at})

    upgrade(url, "head")
    with engine.connect() as connection:
        rows = connection.execute(
            text("SELECT name, position FROM benefits_plans ORDER BY name")
        ).all()
    assert [tuple(row) for row in rows] == [("By hand", 0), ("First", 0), ("Second", 1)]
