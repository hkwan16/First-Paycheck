"""enqueue_sync_for_plaid_item: the webhook's one cross-user write (spec 001, spec 002 rule 26)."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.exc import ProgrammingError

from app.db import service_session, user_session_for
from tests.conftest import FixtureUser
from tests.support.factories import make_item

FUNCTION = "public.enqueue_sync_for_plaid_item(text)"


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def call(connection: Connection, provider_item_id: str) -> None:
    with service_session(bind=connection) as session:
        session.execute(
            text("SELECT public.enqueue_sync_for_plaid_item(:item)"), {"item": provider_item_id}
        )


def jobs(connection: Connection) -> list[dict[str, Any]]:
    rows = connection.execute(
        text("SELECT user_id, kind::text, status::text, payload FROM jobs ORDER BY created_at")
    )
    return [dict(row._mapping) for row in rows]


def test_a_known_item_queues_one_incremental_sync_for_its_owner(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    item = make_item(empty_queue, user_a.id, provider_item_id="plaid-item-a")
    call(empty_queue, "plaid-item-a")
    assert jobs(empty_queue) == [
        {
            "user_id": user_a.id,
            "kind": "sync.incremental",
            "status": "queued",
            "payload": {"sync_item_id": str(item)},
        }
    ]


def test_a_queued_sync_is_not_duplicated(empty_queue: Connection, user_a: FixtureUser) -> None:
    make_item(empty_queue, user_a.id, provider_item_id="plaid-item-a")
    call(empty_queue, "plaid-item-a")
    call(empty_queue, "plaid-item-a")
    assert len(jobs(empty_queue)) == 1

    # Once that job is running, the next webhook queues a fresh sync.
    empty_queue.execute(text("UPDATE jobs SET status = 'running', attempts = 1"))
    call(empty_queue, "plaid-item-a")
    assert [job["status"] for job in jobs(empty_queue)] == ["running", "queued"]


def test_an_unknown_item_is_a_silent_no_op(empty_queue: Connection, user_a: FixtureUser) -> None:
    make_item(empty_queue, user_a.id, provider_item_id="plaid-item-a")
    call(empty_queue, "plaid-item-unknown")
    assert jobs(empty_queue) == []


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
    acl = db_connection.execute(
        text("SELECT proacl::text[] FROM pg_proc WHERE oid = CAST(:fn AS regprocedure)"),
        {"fn": FUNCTION},
    ).scalar_one()
    # An ACL entry starting with "=" is a grant to PUBLIC.
    assert not [entry for entry in acl if entry.startswith("=")]


def test_a_signed_in_user_cannot_call_it(db_connection: Connection, user_a: FixtureUser) -> None:
    make_item(db_connection, user_a.id, provider_item_id="plaid-item-a")
    with (
        pytest.raises(ProgrammingError, match="permission denied"),
        user_session_for(user_a.id, bind=db_connection) as session,
    ):
        session.execute(text("SELECT public.enqueue_sync_for_plaid_item('plaid-item-a')"))


def test_app_api_still_cannot_read_items_directly(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    make_item(db_connection, user_a.id, provider_item_id="plaid-item-a")
    with (
        pytest.raises(ProgrammingError, match="permission denied"),
        service_session(bind=db_connection) as session,
    ):
        session.execute(text("SELECT count(*) FROM sync_items"))


def test_definer_settings(db_connection: Connection) -> None:
    secdef, config = db_connection.execute(
        text("SELECT prosecdef, proconfig FROM pg_proc WHERE oid = CAST(:fn AS regprocedure)"),
        {"fn": FUNCTION},
    ).one()
    assert secdef is True
    assert config == ["search_path=public, pg_temp"]
