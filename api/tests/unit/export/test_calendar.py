"""The iCalendar text (spec 016 rules 18-22, examples 12-15)."""

from __future__ import annotations

import datetime as dt
import uuid

import pytest

from db.enums import CalendarKind, CalendarStatus
from export.calendar import DESCRIPTIONS, IcsEvent, calendar_file, escape_text, fold

STAMP = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)


def physical_lines(text: str) -> list[bytes]:
    assert text.endswith("\r\n")
    return [line.encode() for line in text[:-2].split("\r\n")]


def unfold(text: str) -> str:
    return text.replace("\r\n ", "")


def test_long_lines_fold_at_75_octets() -> None:
    line = "SUMMARY:" + "x" * 200
    folded = fold(line)
    lines = physical_lines(folded + "\r\n")
    assert all(len(physical) <= 75 for physical in lines)
    assert len(lines[0]) == 75
    assert all(physical.startswith(b" ") for physical in lines[1:])
    assert unfold(folded) == line


def test_short_lines_are_not_folded() -> None:
    line = "S" * 75
    assert fold(line) == line


def test_folding_never_splits_a_character() -> None:
    line = "SUMMARY:" + "é" * 100
    folded = fold(line)
    for physical in physical_lines(folded + "\r\n"):
        assert len(physical) <= 75
        physical.decode("utf-8")  # raises when a character was split
    assert unfold(folded) == line


def test_text_is_escaped() -> None:
    assert escape_text("a\\b;c,d\ne") == "a\\\\b\\;c\\,d\\ne"


@pytest.mark.parametrize("kind", list(CalendarKind))
def test_every_calendar_kind_has_a_description(kind: CalendarKind) -> None:
    assert DESCRIPTIONS[kind].strip()


def test_an_empty_calendar_has_no_events() -> None:
    assert calendar_file([], STAMP) == (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "PRODID:-//First Paycheck//Plan calendar//EN\r\n"
        "CALSCALE:GREGORIAN\r\n"
        "METHOD:PUBLISH\r\n"
        "X-WR-CALNAME:First Paycheck\r\n"
        "END:VCALENDAR\r\n"
    )


def test_a_dismissed_event_is_cancelled() -> None:
    event = IcsEvent(
        id=uuid.UUID("00000000-0000-4000-8000-000000000e01"),
        kind=CalendarKind.GOAL_REVIEW,
        title="Review",
        due_at=dt.date(2027, 1, 31),
        status=CalendarStatus.DISMISSED,
    )
    text = calendar_file([event], STAMP)
    assert "STATUS:CANCELLED\r\n" in text
    assert "DTSTART;VALUE=DATE:20270131\r\n" in text
    assert "UID:00000000-0000-4000-8000-000000000e01@first-paycheck\r\n" in text
    assert "DTSTAMP:20261021T150000Z\r\n" in text


def test_the_stamp_is_written_in_utc() -> None:
    pacific = dt.timezone(dt.timedelta(hours=-7))
    text = calendar_file(
        [
            IcsEvent(
                id=uuid.UUID("00000000-0000-4000-8000-000000000e01"),
                kind=CalendarKind.W4_SUBMIT,
                title="W-4",
                due_at=dt.date(2026, 10, 31),
                status=CalendarStatus.UPCOMING,
            )
        ],
        dt.datetime(2026, 10, 21, 8, 0, tzinfo=pacific),
    )
    assert "DTSTAMP:20261021T150000Z\r\n" in text
    assert "STATUS:CONFIRMED\r\n" in text
