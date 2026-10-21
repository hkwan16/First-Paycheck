"""The only module that touches ``document_blobs`` (spec amendment 3, spec 004 rule 4).

Raw upload bytes live in Postgres under row-level security until the user
confirms what was read from them. ``put``, ``get`` and ``delete`` run in the
caller's user session, so RLS applies; ``expire_unconfirmed`` is the retention
step and runs on the scheduler's privileged connection, because it acts on
every user's documents. Storage can move to an object store later behind
these same functions.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass

from sqlalchemy import Connection, select, text
from sqlalchemy import delete as sql_delete
from sqlalchemy.orm import Session

from db.models import DocumentBlob

RETENTION = dt.timedelta(days=7)

__all__ = ["RETENTION", "Blob", "delete", "expire_unconfirmed", "get", "put"]


@dataclass(frozen=True)
class Blob:
    data: bytes
    content_type: str


def put(
    session: Session,
    *,
    document_id: uuid.UUID,
    user_id: uuid.UUID,
    data: bytes,
    content_type: str,
) -> None:
    session.add(
        DocumentBlob(
            document_id=document_id,
            user_id=user_id,
            data=data,
            content_type=content_type,
            size_bytes=len(data),
        )
    )
    session.flush()


def get(session: Session, document_id: uuid.UUID) -> Blob | None:
    """The blob, or None when it was deleted or belongs to someone else."""
    row = session.execute(
        select(DocumentBlob.data, DocumentBlob.content_type).where(
            DocumentBlob.document_id == document_id
        )
    ).one_or_none()
    if row is None:
        return None
    return Blob(data=bytes(row.data), content_type=row.content_type)


def delete(session: Session, document_id: uuid.UUID) -> bool:
    """Delete the blob; True when there was one to delete."""
    deleted = session.execute(
        sql_delete(DocumentBlob)
        .where(DocumentBlob.document_id == document_id)
        .returning(DocumentBlob.document_id)
        .execution_options(synchronize_session=False)
    ).first()
    return deleted is not None


_EXPIRE = text(
    """
    WITH expired AS (
      UPDATE documents
      SET status = 'failed', status_reason = 'expired', deleted_at = :now
      WHERE status <> 'confirmed'
        AND deleted_at IS NULL
        AND created_at < :cutoff
      RETURNING id
    ), removed AS (
      DELETE FROM document_blobs WHERE document_id IN (SELECT id FROM expired)
    )
    SELECT count(*) FROM expired
    """
)


def expire_unconfirmed(connection: Connection, *, now: dt.datetime) -> int:
    """Delete the bytes of every document left unconfirmed for more than seven
    days and mark it ``failed`` (``expired``). Returns how many expired.

    Runs on the privileged connection (``jobs/scheduler.py``); ``now`` is passed
    in so the cutoff is exact and testable.
    """
    expired: int = connection.execute(_EXPIRE, {"now": now, "cutoff": now - RETENTION}).scalar_one()
    return expired
