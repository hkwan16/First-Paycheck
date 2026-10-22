"""The only module that touches ``plan_exports`` (spec 016 rules 14-16).

``put`` (the worker, as the job's user) and ``get`` (the download route) run in
the caller's user session, so RLS applies. ``expire_old`` is the retention
step: it runs in the scheduler tick on the privileged connection, because it
deletes every user's old exports, the way ``ingest/store.py`` expires uploads.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass

from sqlalchemy import Connection, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from db.models import PlanExport

__all__ = ["CONTENT_TYPE", "RETENTION", "StoredExport", "expire_old", "get", "put"]

CONTENT_TYPE = "application/pdf"
RETENTION = dt.timedelta(days=7)


@dataclass(frozen=True)
class StoredExport:
    data: bytes
    content_type: str
    created_at: dt.datetime


def put(
    session: Session,
    *,
    job_id: uuid.UUID,
    user_id: uuid.UUID,
    data: bytes,
    created_at: dt.datetime,
) -> bool:
    """Store the job's PDF. False when the job already stored one, which is kept
    (a requeued job reruns after its first run's bytes were written)."""
    stored = session.execute(
        insert(PlanExport)
        .values(
            job_id=job_id,
            user_id=user_id,
            data=data,
            content_type=CONTENT_TYPE,
            created_at=created_at,
        )
        .on_conflict_do_nothing(index_elements=[PlanExport.job_id])
        .returning(PlanExport.job_id)
    ).first()
    return stored is not None


def get(session: Session, job_id: uuid.UUID) -> StoredExport | None:
    """The export, or None when there is none (expired, not yet written, or not the user's)."""
    row = session.execute(
        select(PlanExport.data, PlanExport.content_type, PlanExport.created_at).where(
            PlanExport.job_id == job_id
        )
    ).one_or_none()
    if row is None:
        return None
    return StoredExport(
        data=bytes(row.data), content_type=row.content_type, created_at=row.created_at
    )


_EXPIRE = text("DELETE FROM plan_exports WHERE created_at < :cutoff")


def expire_old(connection: Connection, *, now: dt.datetime) -> int:
    """Delete every export older than seven days; returns how many went.

    Runs on the privileged connection (``jobs/scheduler.py``); ``now`` is passed
    in so the cutoff is exact and testable.
    """
    expired: int = connection.execute(_EXPIRE, {"cutoff": now - RETENTION}).rowcount
    return expired
