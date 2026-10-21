"""Upcoming dated checkpoints (spec 007 rule 19)."""

from __future__ import annotations

import datetime as dt
import uuid

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from app.deps import UserSession
from app.errors import error_responses
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


@router.get("", responses=error_responses(401))
def list_calendar(session: UserSession) -> list[CalendarEventOut]:
    """Upcoming events, soonest first; done and dismissed ones stay for the plan export."""
    rows = session.scalars(
        select(CalendarEvent)
        .where(CalendarEvent.status == CalendarStatus.UPCOMING)
        .order_by(CalendarEvent.due_at, CalendarEvent.created_at, CalendarEvent.id)
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
