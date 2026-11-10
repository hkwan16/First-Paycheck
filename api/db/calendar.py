"""Which calendar dates are still open, and how many days away one is (spec 015 rule 24).

A calendar event is *settled* when its status is not ``upcoming`` (a newer
version of its decision dismissed it, spec 007 rule 14) or when a date finding
about it (``upcoming_deadline`` or ``overdue_deadline`` with its
``calendar_kind`` and ``due_at``, on any of the user's check-ins) has a user
action. Every other event is *open*, and an open event is *overdue* once its
day has passed. Nothing writes an event's status for the person: their action
on the finding is the one record of what they did, so undo reopens the date
and never an event a newer version dismissed.

``days_until`` is the one count of days. The finders (with the run's date),
``GET /calendar`` and the plan's calendar (with the request's) all go through
it, so what "today" means is decided by each caller and counted here.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import ColumnElement, Select, Text, cast, exists, func, select

from db.enums import CalendarStatus, FindingKind
from db.models import CalendarEvent, CheckInFinding

__all__ = ["DATE_FINDINGS", "days_until", "is_overdue", "open_events", "settled_by_finding"]

# The finding kinds that are about a calendar date (spec 015 rule 7).
DATE_FINDINGS = (FindingKind.UPCOMING_DEADLINE, FindingKind.OVERDUE_DEADLINE)


def days_until(due_at: dt.date, today: dt.date) -> int:
    """Whole days from ``today`` to ``due_at``: 0 on the day, negative once it passed."""
    return (due_at - today).days


def is_overdue(due_at: dt.date, today: dt.date) -> bool:
    """An open date is overdue once its day is before ``today``."""
    return days_until(due_at, today) < 0


def settled_by_finding() -> ColumnElement[bool]:
    """True for an event whose date a check-in finding was marked done or dismissed on."""
    return exists().where(
        CheckInFinding.user_id == CalendarEvent.user_id,
        CheckInFinding.kind.in_(DATE_FINDINGS),
        CheckInFinding.user_action.is_not(None),
        CheckInFinding.payload["calendar_kind"].astext == cast(CalendarEvent.kind, Text),
        CheckInFinding.payload["due_at"].astext == func.to_char(CalendarEvent.due_at, "YYYY-MM-DD"),
    )


def open_events() -> Select[CalendarEvent]:
    """The user's open events (under their RLS session); callers add order and window."""
    return select(CalendarEvent).where(
        CalendarEvent.status == CalendarStatus.UPCOMING, ~settled_by_finding()
    )
