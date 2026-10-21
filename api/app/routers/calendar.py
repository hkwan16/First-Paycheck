"""Upcoming dated checkpoints (spec 007 rule 19), optionally in a window (spec 015 rule 22)."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.deps import UserSession
from app.errors import AppError, error_responses
from db.enums import CalendarKind, CalendarStatus
from db.models import CalendarEvent

router = APIRouter(prefix="/calendar", tags=["calendar"])


class CalendarEventOut(BaseModel):
    id: uuid.UUID
    kind: CalendarKind
    title: str
    due_at: dt.date
    decision_id: uuid.UUID | None
    status: CalendarStatus


@router.get("", responses=error_responses(401, 422))
def list_calendar(
    session: UserSession,
    start: Annotated[
        dt.date | None, Query(alias="from", description="Earliest due date, inclusive")
    ] = None,
    end: Annotated[
        dt.date | None, Query(alias="to", description="Latest due date, inclusive")
    ] = None,
) -> list[CalendarEventOut]:
    """Upcoming events, soonest first; done and dismissed ones stay for the plan export."""
    if start is not None and end is not None and start > end:
        raise AppError("from must not be after to", code="validation_error", status_code=422)
    query = select(CalendarEvent).where(CalendarEvent.status == CalendarStatus.UPCOMING)
    if start is not None:
        query = query.where(CalendarEvent.due_at >= start)
    if end is not None:
        query = query.where(CalendarEvent.due_at <= end)
    rows = session.scalars(
        query.order_by(CalendarEvent.due_at, CalendarEvent.created_at, CalendarEvent.id)
    )
    return [
        CalendarEventOut(
            id=row.id,
            kind=row.kind,
            title=row.title,
            due_at=row.due_at,
            decision_id=row.decision_id,
            status=row.status,
        )
        for row in rows
    ]
