"""Open dated checkpoints (spec 007 rule 19, spec 015 rules 22 and 24), optionally in a
window, each marked overdue once its day has passed."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.deps import Now, UserSession
from app.errors import AppError, error_responses
from db.calendar import is_overdue, open_events
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
    # Open and its day has passed (spec 015 rule 24).
    overdue: bool


def event_out(row: CalendarEvent, today: dt.date) -> CalendarEventOut:
    """An event as the API lists it, overdue as of ``today``."""
    return CalendarEventOut(
        id=row.id,
        kind=row.kind,
        title=row.title,
        due_at=row.due_at,
        decision_id=row.decision_id,
        status=row.status,
        overdue=is_overdue(row.due_at, today),
    )


@router.get("", responses=error_responses(401, 422))
def list_calendar(
    session: UserSession,
    now: Now,
    start: Annotated[
        dt.date | None, Query(alias="from", description="Earliest due date, inclusive")
    ] = None,
    end: Annotated[
        dt.date | None, Query(alias="to", description="Latest due date, inclusive")
    ] = None,
) -> list[CalendarEventOut]:
    """Open events, soonest first; done, dismissed and settled ones stay for the plan export."""
    if start is not None and end is not None and start > end:
        raise AppError("from must not be after to", code="validation_error", status_code=422)
    query = open_events()
    if start is not None:
        query = query.where(CalendarEvent.due_at >= start)
    if end is not None:
        query = query.where(CalendarEvent.due_at <= end)
    rows = session.scalars(
        query.order_by(CalendarEvent.due_at, CalendarEvent.created_at, CalendarEvent.id)
    )
    return [event_out(row, now.date()) for row in rows]
