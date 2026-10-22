"""The plan, its calendar file and its PDF export (spec 016)."""

from __future__ import annotations

from fastapi import APIRouter, Response
from sqlalchemy import select

from app.deps import Now, UserSession
from app.errors import error_responses
from app.plan import PlanOut, build_plan
from db.models import CalendarEvent
from export.calendar import IcsEvent, calendar_file

router = APIRouter(prefix="/plan", tags=["plan"])

CALENDAR_FILENAME = "first-paycheck-calendar.ics"


@router.get("", responses=error_responses(401))
def get_plan(session: UserSession, now: Now) -> PlanOut:
    """Every current decision with its figures, the goals, the next 90 days and the pay stub."""
    return build_plan(session, now.date())


@router.get(
    "/calendar.ics",
    response_class=Response,
    responses={
        200: {"content": {"text/calendar": {"schema": {"type": "string"}}}},
        **error_responses(401),
    },
)
def get_plan_calendar(session: UserSession, now: Now) -> Response:
    """Every calendar event, any status, as an iCalendar file to import (RFC 5545)."""
    rows = session.scalars(
        select(CalendarEvent).order_by(CalendarEvent.due_at, CalendarEvent.kind, CalendarEvent.id)
    )
    events = [
        IcsEvent(id=row.id, kind=row.kind, title=row.title, due_at=row.due_at, status=row.status)
        for row in rows
    ]
    return Response(
        content=calendar_file(events, now).encode("utf-8"),
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{CALENDAR_FILENAME}"'},
    )
