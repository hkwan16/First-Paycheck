"""``GET /plan/calendar.ics`` (spec 016 rules 18-22, example 11)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.db import user_session_for
from app.deps import get_now
from db.enums import CalendarKind, CalendarStatus
from db.models import CalendarEvent
from tests.conftest import FixtureUser

NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)
FIXTURE = Path(__file__).parent.parent / "fixtures" / "export" / "calendar.ics"
Client = Callable[[FixtureUser], TestClient]

ELECTION_TITLE = "Check that your next pay stub shows your new 401(k) contribution"


@pytest.fixture
def frozen_app(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_now] = lambda: NOW
    return app


def event_id(n: int) -> uuid.UUID:
    return uuid.UUID(f"00000000-0000-4000-8000-000000000e{n:02d}")


def seed_events(connection: Connection, user: FixtureUser) -> None:
    """Example 11's events, inserted out of order to show the file sorts them."""
    rows = [
        (4, CalendarKind.ENROLLMENT_DEADLINE, "Health plan enrollment deadline; Acme, 2027 plans",
         dt.date(2026, 11, 14), CalendarStatus.UPCOMING),
        (2, CalendarKind.ELECTION_CHECK, ELECTION_TITLE, dt.date(2026, 10, 31),
         CalendarStatus.DISMISSED),
        (1, CalendarKind.ELECTION_CHECK, ELECTION_TITLE, dt.date(2026, 10, 31),
         CalendarStatus.UPCOMING),
        (3, CalendarKind.W4_SUBMIT, "Give your employer your updated Form W-4",
         dt.date(2026, 10, 15), CalendarStatus.DONE),
    ]  # fmt: skip
    with user_session_for(user.id, bind=connection) as session:
        for n, kind, title, due_at, status in rows:
            session.add(
                CalendarEvent(
                    id=event_id(n),
                    user_id=user.id,
                    kind=kind,
                    title=title,
                    due_at=due_at,
                    status=status,
                )
            )
        session.flush()


def test_calendar_file_matches_the_fixture(
    frozen_app: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    seed_events(db_connection, user_a)
    response = client_as(user_a).get("/plan/calendar.ics")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "text/calendar; charset=utf-8"
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="first-paycheck-calendar.ics"'
    )
    assert response.content == FIXTURE.read_bytes()


def test_a_user_without_events_gets_an_empty_calendar(
    frozen_app: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    response = client_as(user_a).get("/plan/calendar.ics")
    assert response.status_code == 200
    assert "BEGIN:VEVENT" not in response.text
    assert response.text.endswith("END:VCALENDAR\r\n")
