"""The user's decision calendar as an iCalendar file (RFC 5545; spec 016 rules 18-22).

Written with the standard library: the format needs escaping, CRLF line ends
and folding, nothing a dependency would add. Every event is an all-day date,
so there are no time zones. The ``UID`` is the event's id, so importing a
newer file updates (or, with ``STATUS:CANCELLED``, removes) what an earlier
import added.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from db.enums import CalendarKind, CalendarStatus

__all__ = ["DESCRIPTIONS", "IcsEvent", "calendar_file", "escape_text", "fold"]

CRLF = "\r\n"
# RFC 5545 section 3.1: lines SHOULD NOT be longer than 75 octets.
MAX_OCTETS = 75
PRODID = "-//First Paycheck//Plan calendar//EN"
UID_DOMAIN = "first-paycheck"

# One sentence per kind (rule 20). A kind missing here fails the tests, so a
# new calendar kind cannot ship without its text.
DESCRIPTIONS: Mapping[CalendarKind, str] = {
    CalendarKind.ENROLLMENT_DEADLINE: (
        "Last day to enroll in the health plan you chose in First Paycheck."
    ),
    CalendarKind.TAX_SEASON: (
        "Tax season: compare your W-2 with the federal tax your plan projected."
    ),
    CalendarKind.OPEN_ENROLLMENT: (
        "Open enrollment: run the health plan comparison again with this year's care."
    ),
    CalendarKind.GOAL_TARGET: "The date your savings goal is projected to be reached.",
    CalendarKind.ELECTION_CHECK: (
        "Check that your pay stub shows the 401(k) contribution you chose."
    ),
    CalendarKind.GOAL_CONTRIBUTION: "Move this month's emergency fund contribution into savings.",
    CalendarKind.GOAL_REVIEW: (
        "Look at your emergency fund progress and adjust the monthly amount if needed."
    ),
    CalendarKind.W4_SUBMIT: "Give your employer the Form W-4 entries from your plan.",
}


@dataclass(frozen=True)
class IcsEvent:
    id: uuid.UUID
    kind: CalendarKind
    title: str
    due_at: dt.date
    status: CalendarStatus


def escape_text(value: str) -> str:
    """A TEXT value (section 3.3.11): backslash, semicolon, comma and newline escaped."""
    return (
        value.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def fold(line: str) -> str:
    """Fold a content line at 75 octets (section 3.1), never inside a UTF-8 character.

    The first physical line holds up to 75 octets; each continuation starts with
    one space and holds up to 74 more.
    """
    data = line.encode("utf-8")
    if len(data) <= MAX_OCTETS:
        return line
    parts: list[bytes] = []
    start = 0
    limit = MAX_OCTETS
    while len(data) - start > limit:
        end = start + limit
        # Back up to the start of a character: continuation octets are 10xxxxxx.
        while data[end] & 0b1100_0000 == 0b1000_0000:
            end -= 1
        parts.append(data[start:end])
        start = end
        limit = MAX_OCTETS - 1
    parts.append(data[start:])
    return (CRLF + " ").join(part.decode("utf-8") for part in parts)


def _stamp(now: dt.datetime) -> str:
    return now.astimezone(dt.UTC).strftime("%Y%m%dT%H%M%SZ")


def _event_lines(event: IcsEvent, stamp: str) -> list[str]:
    status = "CANCELLED" if event.status is CalendarStatus.DISMISSED else "CONFIRMED"
    return [
        "BEGIN:VEVENT",
        f"UID:{event.id}@{UID_DOMAIN}",
        f"DTSTAMP:{stamp}",
        # An all-day event; without DTEND it lasts the one day (section 3.6.1).
        f"DTSTART;VALUE=DATE:{event.due_at:%Y%m%d}",
        f"SUMMARY:{escape_text(event.title)}",
        f"DESCRIPTION:{escape_text(DESCRIPTIONS[event.kind])}",
        f"STATUS:{status}",
        "END:VEVENT",
    ]


def calendar_file(events: Iterable[IcsEvent], now: dt.datetime) -> str:
    """The whole file, events in the order given, stamped ``now`` (in UTC)."""
    stamp = _stamp(now)
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{PRODID}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:First Paycheck",
    ]
    for event in events:
        lines.extend(_event_lines(event, stamp))
    lines.append("END:VCALENDAR")
    return "".join(fold(line) + CRLF for line in lines)
