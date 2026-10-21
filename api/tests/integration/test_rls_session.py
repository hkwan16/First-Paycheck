"""The per-request RLS session: role switch plus JWT claims inside one transaction."""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import DBAPIError

from app.db import current_alembic_revision, make_engine, user_session, user_session_for
from app.deps import UserSession
from db.rls import rls_statements
from tests.conftest import FixtureUser
from tests.support.database import head_revision


@pytest.fixture
def scratch_table(db_connection: Connection) -> str:
    """A user-owned table under the standard RLS policy, rolled back after the test."""
    db_connection.execute(
        text(
            "CREATE TABLE public.scratch_notes ("
            " id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
            " user_id uuid NOT NULL DEFAULT public.current_user_id() REFERENCES auth.users(id),"
            " body text NOT NULL)"
        )
    )
    for statement in rls_statements("scratch_notes"):
        db_connection.execute(text(statement))
    return "scratch_notes"


def bodies(connection: Connection, user: FixtureUser) -> list[str]:
    with user_session(user.claims, bind=connection) as session:
        return list(session.execute(text("SELECT body FROM scratch_notes ORDER BY body")).scalars())


def test_rows_are_visible_only_to_their_owner(
    db_connection: Connection, scratch_table: str, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    with user_session(user_a.claims, bind=db_connection) as session:
        session.execute(text("INSERT INTO scratch_notes (body) VALUES ('a1'), ('a2')"))

    assert bodies(db_connection, user_a) == ["a1", "a2"]
    assert bodies(db_connection, user_b) == []


def test_a_user_cannot_write_rows_for_someone_else(
    db_connection: Connection, scratch_table: str, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    with (
        pytest.raises(DBAPIError, match="row-level security"),
        user_session(user_b.claims, bind=db_connection) as session,
    ):
        session.execute(
            text("INSERT INTO scratch_notes (user_id, body) VALUES (:owner, 'forged')"),
            {"owner": user_a.id},
        )
    assert bodies(db_connection, user_a) == []


def test_a_user_cannot_update_or_delete_someone_elses_rows(
    db_connection: Connection, scratch_table: str, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    with user_session(user_a.claims, bind=db_connection) as session:
        session.execute(text("INSERT INTO scratch_notes (body) VALUES ('mine')"))
    with user_session(user_b.claims, bind=db_connection) as session:
        assert not session.execute(text("UPDATE scratch_notes SET body = 'x' RETURNING id")).all()
        assert not session.execute(text("DELETE FROM scratch_notes RETURNING id")).all()
    assert bodies(db_connection, user_a) == ["mine"]


def test_user_session_for_serves_the_worker(
    db_connection: Connection, scratch_table: str, user_a: FixtureUser
) -> None:
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(text("INSERT INTO scratch_notes (body) VALUES ('from a job')"))
    assert bodies(db_connection, user_a) == ["from a job"]


def test_claims_without_a_subject_are_refused() -> None:
    with pytest.raises(ValueError, match="sub"), user_session({"role": "authenticated"}):
        pass


@pytest.fixture
def app_api_engine(app_api_url: str) -> Iterator[Engine]:
    """The production engine configuration, logged in as app_api, one pooled connection."""
    engine = make_engine(app_api_url, pool_size=1, max_overflow=0)
    yield engine
    engine.dispose()


def connection_state(engine: Engine) -> tuple[int, str, str, str | None]:
    with engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT pg_backend_pid(), current_user, session_user,"
                " nullif(current_setting('request.jwt.claims', true), '')"
            )
        ).one()
        return row[0], row[1], row[2], row[3]


def test_role_and_claims_reset_after_commit(app_api_engine: Engine) -> None:
    user_id = uuid.uuid4()
    with user_session_for(user_id, bind=app_api_engine) as session:
        pid, role, login = session.execute(
            text("SELECT pg_backend_pid(), current_user, session_user")
        ).one()
        assert (role, login) == ("authenticated", "app_api")
        assert session.execute(text("SELECT public.current_user_id()")).scalar() == user_id

    assert connection_state(app_api_engine) == (pid, "app_api", "app_api", None)


def test_role_and_claims_reset_after_an_error(app_api_engine: Engine) -> None:
    pid = connection_state(app_api_engine)[0]
    with pytest.raises(RuntimeError), user_session_for(uuid.uuid4(), bind=app_api_engine):
        raise RuntimeError("handler failed")
    assert connection_state(app_api_engine) == (pid, "app_api", "app_api", None)


def test_app_api_holds_no_privileges_without_the_role_switch(app_api_engine: Engine) -> None:
    # app_api is NOINHERIT, so authenticated's grants apply only after SET ROLE.
    with app_api_engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT has_function_privilege('public.current_user_id()', 'EXECUTE')")
            ).scalar_one()
            is False
        )
        with pytest.raises(DBAPIError, match="permission denied"):
            connection.execute(text("SELECT public.current_user_id()"))


def test_app_api_can_read_the_alembic_revision(app_api_engine: Engine) -> None:
    with app_api_engine.connect() as connection:
        assert current_alembic_revision(connection) == head_revision()


def test_engine_disables_prepared_statements(app_api_engine: Engine) -> None:
    with app_api_engine.connect() as connection:
        raw = connection.connection.dbapi_connection
        assert raw is not None
        assert raw.prepare_threshold is None


@pytest.fixture
def whoami(app: FastAPI) -> FastAPI:
    router = APIRouter()

    @router.get("/whoami")
    def whoami_route(session: UserSession) -> dict[str, str]:
        row = session.execute(text("SELECT public.current_user_id(), current_user")).one()
        return {"user_id": str(row[0]), "role": row[1]}

    app.include_router(router)
    return app


def test_requests_run_as_the_token_subject(
    whoami: FastAPI, client_as: Callable[[FixtureUser], TestClient], user_a: FixtureUser
) -> None:
    response = client_as(user_a).get("/whoami")
    assert response.status_code == 200
    assert response.json() == {"user_id": str(user_a.id), "role": "authenticated"}


def test_requests_without_a_token_never_open_a_session(whoami: FastAPI) -> None:
    response = TestClient(whoami).get("/whoami")
    assert response.status_code == 401
