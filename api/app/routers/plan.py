"""The plan, its calendar file and its PDF export (spec 016).

The PDF is rendered by the worker (``plan.export``): the API process never
imports WeasyPrint. ``POST /plan/export`` queues the job, the client polls
``GET /jobs/{id}``, and ``GET /plan/export/{job_id}`` streams the stored bytes.
"""

from __future__ import annotations

import datetime as dt
import uuid

from fastapi import APIRouter, Response, status
from pydantic import BaseModel
from sqlalchemy import select

from app import ratelimit
from app.auth import CurrentUser
from app.deps import Now, UserSession
from app.errors import NotFound, error_responses
from app.plan import PlanOut, build_plan
from db.enums import JobKind, JobStatus
from db.models import CalendarEvent, Job
from export import store as export_store
from export.calendar import IcsEvent, calendar_file
from jobs import queue

router = APIRouter(prefix="/plan", tags=["plan"])

CALENDAR_FILENAME = "first-paycheck-calendar.ics"


class PlanExportQueued(BaseModel):
    job_id: uuid.UUID


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


@router.post("/export", status_code=status.HTTP_202_ACCEPTED, responses=error_responses(401, 429))
def export_plan(session: UserSession, user: CurrentUser, now: Now) -> PlanExportQueued:
    """Queue the plan PDF; a second request while one is waiting returns the same job."""
    ratelimit.consume(session, user.id, ratelimit.PLAN_EXPORTS, now=now)
    job_id = queue.enqueue_unless_queued(session, user_id=user.id, kind=JobKind.PLAN_EXPORT)
    return PlanExportQueued(job_id=job_id)


@router.get(
    "/export/{job_id}",
    response_class=Response,
    responses={
        200: {"content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}}},
        **error_responses(401, 404),
    },
)
def download_plan_export(job_id: uuid.UUID, session: UserSession) -> Response:
    """The PDF once its job succeeded; 404 before then, after 7 days and for anyone else."""
    job = session.get(Job, job_id)
    if job is None or job.kind is not JobKind.PLAN_EXPORT or job.status is not JobStatus.SUCCEEDED:
        raise NotFound("Plan export not found")
    stored = export_store.get(session, job_id)
    if stored is None:
        raise NotFound("Plan export not found")
    filename = f"first-paycheck-plan-{stored.created_at.astimezone(dt.UTC):%Y-%m-%d}.pdf"
    return Response(
        content=stored.data,
        media_type=stored.content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
