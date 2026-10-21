"""ingest/store.py: the only door to document_blobs (spec 004 rules 4, 20-21)."""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import Connection, text

from app.db import user_session_for
from ingest import store
from tests.conftest import FixtureUser
from tests.support.factories import make_document

PDF = b"%PDF-1.4 tiny"
NOW = dt.datetime(2026, 11, 20, 12, 0, tzinfo=dt.UTC)


def test_put_get_delete_round_trip(db_connection: Connection, user_a: FixtureUser) -> None:
    document = make_document(db_connection, user_a.id, with_blob=False)
    with user_session_for(user_a.id, bind=db_connection) as session:
        store.put(
            session,
            document_id=document,
            user_id=user_a.id,
            data=PDF,
            content_type="application/pdf",
        )
    with user_session_for(user_a.id, bind=db_connection) as session:
        blob = store.get(session, document)
        assert blob == store.Blob(data=PDF, content_type="application/pdf")
        assert store.delete(session, document) is True
        assert store.delete(session, document) is False
        assert store.get(session, document) is None


def test_other_users_cannot_read_a_blob(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    document = make_document(db_connection, user_a.id)
    with user_session_for(user_b.id, bind=db_connection) as session:
        assert store.get(session, document) is None
        assert store.delete(session, document) is False
    with user_session_for(user_a.id, bind=db_connection) as session:
        assert store.get(session, document) is not None


def created(connection: Connection, document: uuid.UUID, at: dt.datetime) -> None:
    connection.execute(
        text("UPDATE documents SET created_at = :at WHERE id = :id"), {"at": at, "id": document}
    )


def state(connection: Connection, document: uuid.UUID) -> tuple[str, str | None, bool, bool]:
    row = connection.execute(
        text(
            "SELECT status::text, status_reason::text, deleted_at IS NOT NULL,"
            " EXISTS (SELECT 1 FROM document_blobs WHERE document_id = d.id)"
            " FROM documents d WHERE id = :id"
        ),
        {"id": document},
    ).one()
    return row[0], row[1], row[2], row[3]


def test_expire_unconfirmed_at_frozen_time(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    old = make_document(db_connection, user_a.id)
    created(db_connection, old, NOW - dt.timedelta(days=7, seconds=1))
    edge = make_document(db_connection, user_b.id)
    created(db_connection, edge, NOW - dt.timedelta(days=7))
    fresh = make_document(db_connection, user_a.id)
    created(db_connection, fresh, NOW - dt.timedelta(days=1))
    confirmed = make_document(db_connection, user_a.id, with_blob=False)
    db_connection.execute(
        text(
            "UPDATE documents SET status = 'confirmed', confirmed_at = :at, deleted_at = :at,"
            " created_at = :old WHERE id = :id"
        ),
        {"at": NOW - dt.timedelta(days=8), "old": NOW - dt.timedelta(days=9), "id": confirmed},
    )

    assert store.expire_unconfirmed(db_connection, now=NOW) == 1

    assert state(db_connection, old) == ("failed", "expired", True, False)
    assert state(db_connection, edge) == ("uploaded", None, False, True)
    assert state(db_connection, fresh) == ("uploaded", None, False, True)
    assert state(db_connection, confirmed)[:3] == ("confirmed", None, True)
    # Idempotent: a second pass finds nothing left to expire.
    assert store.expire_unconfirmed(db_connection, now=NOW) == 0
