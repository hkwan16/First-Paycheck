"""Account deletion: ``DELETE /me`` and ``delete_user_account(uuid)`` (spec 017)."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError

from app.config import get_settings
from app.db import service_session, user_session_for
from app.deps import get_optional_plaid_client
from db.enums import CalculatorKind, JobKind, SyncProvider
from jobs.context import JobContext, Services
from jobs.worker import Worker
from sync.crypto import cipher_from_settings
from tests.conftest import FixtureUser
from tests.support.factories import make_decision, make_item, make_job
from tests.support.fake_plaid import FakePlaidClient, plaid_error
from tests.support.full_user import NOW, populate_every_table, row_counts, user_tables

Client = Callable[[FixtureUser], TestClient]
FUNCTION = "public.delete_user_account(uuid)"


def encrypted(token: str) -> bytes:
    return cipher_from_settings(get_settings()).encrypt(SecretStr(token))


def auth_user_exists(connection: Connection, user: FixtureUser) -> bool:
    return bool(
        connection.execute(
            text("SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = :id)"), {"id": user.id}
        ).scalar_one()
    )


def owned_rows(connection: Connection, user: FixtureUser) -> dict[str, int]:
    return {name: n for name, n in row_counts(connection, user.id).items() if n}


# ---------------------------------------------------------------- the route


def test_delete_account_empties_every_user_table(
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    user_b: FixtureUser,
    fake_plaid: FakePlaidClient,
) -> None:
    seeded = populate_every_table(db_connection, user_a.id)
    populate_every_table(db_connection, user_b.id)
    before_a = row_counts(db_connection, user_a.id)
    before_b = row_counts(db_connection, user_b.id)
    # Every user table is covered, so a new table cannot pass unchecked.
    assert [name for name, n in before_a.items() if n == 0] == []
    assert set(before_a) == set(user_tables(db_connection))

    response = client_as(user_a).delete("/me")

    assert response.status_code == 204, response.text
    assert response.content == b""
    assert owned_rows(db_connection, user_a) == {}
    assert not auth_user_exists(db_connection, user_a)
    assert row_counts(db_connection, user_b.id) == before_b
    assert auth_user_exists(db_connection, user_b)
    assert fake_plaid.removed == [seeded.plaid_token]


def test_delete_account_keeps_ownerless_rows(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    db_connection.execute(text("INSERT INTO jobs (kind) VALUES ('schedule.tick')"))
    db_connection.execute(
        text(
            "INSERT INTO category_rules (merchant_norm, match, category, source)"
            " VALUES ('m10-seed-merchant', 'exact', 'GENERAL_MERCHANDISE', 'seed')"
        )
    )
    ownerless = text(
        "SELECT (SELECT count(*) FROM jobs WHERE user_id IS NULL),"
        " (SELECT count(*) FROM category_rules WHERE user_id IS NULL)"
    )
    before = db_connection.execute(ownerless).one()

    assert client_as(user_a).delete("/me").status_code == 204

    assert db_connection.execute(ownerless).one() == before


def test_delete_account_revokes_every_plaid_item(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient
) -> None:
    make_item(db_connection, user_a.id, access_token_enc=encrypted("access-one"))
    make_item(db_connection, user_a.id, access_token_enc=encrypted("access-two"))
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(
            text(
                "INSERT INTO sync_items (user_id, provider, institution_name)"
                " VALUES (:u, :p, 'Credit union CSV')"
            ),
            {"u": user_a.id, "p": SyncProvider.CSV.value},
        )

    assert client_as(user_a).delete("/me").status_code == 204

    assert sorted(fake_plaid.removed) == ["access-one", "access-two"]
    assert [name for name, _ in fake_plaid.calls].count("item_remove") == 2
    assert owned_rows(db_connection, user_a) == {}


def test_delete_account_survives_plaid_failures(
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    fake_plaid: FakePlaidClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    good = make_item(db_connection, user_a.id, access_token_enc=encrypted("access-good"))
    broken = make_item(db_connection, user_a.id, access_token_enc=b"not-a-fernet-token")
    fake_plaid.fail["item_remove"] = plaid_error("INTERNAL_SERVER_ERROR", "API_ERROR", 500)

    with caplog.at_level(logging.WARNING, logger="sync.revoke"):
        response = client_as(user_a).delete("/me")

    assert response.status_code == 204, response.text
    assert owned_rows(db_connection, user_a) == {}
    warned = " ".join(record.getMessage() for record in caplog.records)
    assert str(good) in warned
    assert str(broken) in warned
    assert "access-good" not in warned


def test_delete_account_without_plaid_configured(
    app: FastAPI,
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    caplog: pytest.LogCaptureFixture,
) -> None:
    item = make_item(db_connection, user_a.id, access_token_enc=encrypted("access-a"))
    app.dependency_overrides[get_optional_plaid_client] = lambda: None

    with caplog.at_level(logging.WARNING, logger="sync.revoke"):
        response = client_as(user_a).delete("/me")

    assert response.status_code == 204, response.text
    assert owned_rows(db_connection, user_a) == {}
    assert str(item) in " ".join(record.getMessage() for record in caplog.records)


def test_delete_account_twice_is_204(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    assert client.delete("/me").status_code == 204
    assert client.delete("/me").status_code == 204
    assert not auth_user_exists(db_connection, user_a)


def test_write_after_deletion_is_401(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    assert client.delete("/me").status_code == 204

    response = client.put("/profile", json={"salary_cents": 6_500_000})

    assert response.status_code == 401, response.text
    assert response.json()["error"]["code"] == "account_deleted"
    assert owned_rows(db_connection, user_a) == {}


def test_delete_account_needs_a_token(app: FastAPI) -> None:
    assert TestClient(app).delete("/me").status_code == 401


def test_every_owner_key_is_named_for_the_error_handler(db_connection: Connection) -> None:
    """``app.errors.is_missing_owner`` recognises the key by its name."""
    keys: dict[str, str] = dict(
        db_connection.execute(
            text(
                "SELECT conrelid::regclass::text, conname FROM pg_constraint"
                " WHERE contype = 'f' AND confrelid = 'auth.users'::regclass"
            )
        ).all()
    )
    assert set(keys) == set(user_tables(db_connection))
    assert {name: f"fk_{name}_user_id_users" for name in keys} == keys


# ---------------------------------------------------------------- the function


def call(connection: Connection, user: FixtureUser | None) -> Any:
    with service_session(bind=connection) as session:
        return session.execute(
            text("SELECT public.delete_user_account(:id)"), {"id": user.id if user else None}
        ).scalar_one()


def test_the_function_deletes_one_user_and_says_so(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    assert call(db_connection, user_a) is True
    assert call(db_connection, user_a) is False
    assert not auth_user_exists(db_connection, user_a)
    assert auth_user_exists(db_connection, user_b)


def test_the_function_refuses_a_null_id(db_connection: Connection) -> None:
    with pytest.raises(DBAPIError, match="user id is required"):
        call(db_connection, None)


def test_only_app_api_may_execute_it(db_connection: Connection) -> None:
    def can(role: str) -> bool:
        return bool(
            db_connection.execute(
                text("SELECT has_function_privilege(:role, :fn, 'EXECUTE')"),
                {"role": role, "fn": FUNCTION},
            ).scalar_one()
        )

    assert can("app_api")
    assert not can("authenticated")
    assert not can("anon")
    public = db_connection.execute(
        text(
            "SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) acl"
            " WHERE p.oid = CAST(:fn AS regprocedure) AND acl.grantee = 0)"
        ),
        {"fn": FUNCTION},
    ).scalar_one()
    assert public is False


def test_an_authenticated_user_cannot_call_it(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    with (
        pytest.raises(DBAPIError, match="permission denied"),
        user_session_for(user_a.id, bind=db_connection) as session,
    ):
        session.execute(text("SELECT public.delete_user_account(:id)"), {"id": user_a.id})
    assert auth_user_exists(db_connection, user_a)


def test_direct_decision_delete_still_raises(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    inputs = {"contribution_pct": "4"}
    make_decision(db_connection, user_a.id, CalculatorKind.K401_MATCH, inputs, created_at=NOW)
    with (
        pytest.raises(DBAPIError, match="decisions are immutable"),
        db_connection.begin_nested(),
    ):
        db_connection.execute(text("DELETE FROM decisions WHERE user_id = :u"), {"u": user_a.id})


# ---------------------------------------------------------------- the worker


def test_running_job_of_a_deleted_user_does_not_stop_the_worker(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    db_connection.execute(text("DELETE FROM jobs"))
    make_job(db_connection, user_a.id, kind=JobKind.CATEGORIZE_RUN)
    queued_behind = make_job(db_connection, user_a.id, kind=JobKind.CATEGORIZE_RUN)

    def handler(ctx: JobContext) -> dict[str, Any]:
        # The account is deleted while the handler runs; its next write fails.
        call(db_connection, user_a)
        with ctx.user_session() as session:
            session.execute(
                text("INSERT INTO profiles (user_id, salary_cents) VALUES (:u, 1)"),
                {"u": user_a.id},
            )
        return {}

    worker = Worker(
        handlers={JobKind.CATEGORIZE_RUN: handler},
        services=Services(clock=lambda: NOW),
        queue_bind=db_connection,
        user_bind=db_connection,
    )

    assert worker.run_once() is True
    assert worker.run_once() is False  # the job queued behind it went with the account
    remaining = db_connection.execute(
        text("SELECT count(*) FROM jobs WHERE user_id = :u OR id = :q"),
        {"u": user_a.id, "q": queued_behind},
    ).scalar_one()
    assert remaining == 0
