"""The person's day (spec 019): what "today" is for the person, never the server's UTC day.

``person_day_at(now, zone)`` is the one place an instant becomes the person's
date. ``person_day(session, user_id, now)`` reads the zone the browser reported
(``profiles.time_zone``) in the caller's RLS session and answers the same; every
route (through ``app.deps.Day``) and job handler learns today from it. The
scheduler reads every user's zone on its own connection and calls
``person_day_at`` with ``zone_for``.

Stored timestamps stay UTC and due dates stay plain dates: only the step from
an instant to a date takes the zone.
"""

from __future__ import annotations

import datetime as dt
import functools
import logging
import uuid
import zoneinfo
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import Profile

__all__ = [
    "DEFAULT_TIME_ZONE",
    "MAX_TIME_ZONE_LENGTH",
    "PersonDay",
    "day_in",
    "is_time_zone",
    "person_day",
    "person_day_at",
    "zone_for",
]

logger = logging.getLogger(__name__)

# Rule 1: First Paycheck serves US employees, so a person whose browser has not
# reported a zone yet is closer to New York than to UTC.
DEFAULT_TIME_ZONE = "America/New_York"
MAX_TIME_ZONE_LENGTH = 64


@functools.cache
def _known_time_zones() -> frozenset[str]:
    return frozenset(zoneinfo.available_timezones())


def is_time_zone(name: str) -> bool:
    """Rule 4: an IANA name the tz database (the ``tzdata`` package) knows."""
    return len(name) <= MAX_TIME_ZONE_LENGTH and name in _known_time_zones()


def zone_for(name: str | None, *, user_id: uuid.UUID | None = None) -> zoneinfo.ZoneInfo:
    """Rule 1: the saved zone, else the default; a name no longer known is the default."""
    if name is None:
        return zoneinfo.ZoneInfo(DEFAULT_TIME_ZONE)
    if not is_time_zone(name):
        # The name came from a browser; it is not logged.
        logger.warning(
            "the saved time zone is not a known time zone; using the default",
            extra={"user_id": str(user_id) if user_id else None},
        )
        return zoneinfo.ZoneInfo(DEFAULT_TIME_ZONE)
    return zoneinfo.ZoneInfo(name)


def day_in(moment: dt.datetime, zone: zoneinfo.ZoneInfo) -> dt.date:
    """Rules 2 and 3: the date of an instant in ``zone``."""
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError("an instant needs a time zone; stored timestamps are UTC")
    return moment.astimezone(zone).date()


@dataclass(frozen=True)
class PersonDay:
    """The person's zone in effect and their date at one instant."""

    zone: zoneinfo.ZoneInfo
    today: dt.date

    @property
    def month(self) -> dt.date:
        """The first day of ``today``'s month."""
        return self.today.replace(day=1)

    def day_of(self, moment: dt.datetime) -> dt.date:
        """Rule 3: the date of a stored instant in the person's zone."""
        return day_in(moment, self.zone)

    def start_of(self, day: dt.date) -> dt.datetime:
        """The first instant of ``day`` in the zone, in UTC.

        A midnight a DST change skips is read with the offset before the change
        (``fold=0``), which is the change itself: the first instant of the day
        that exists. A midnight that repeats is its first occurrence.
        """
        return dt.datetime.combine(day, dt.time(), tzinfo=self.zone).astimezone(dt.UTC)


def person_day_at(now: dt.datetime, zone: zoneinfo.ZoneInfo) -> PersonDay:
    """Rule 2: the person's date at ``now`` in ``zone``."""
    return PersonDay(zone=zone, today=day_in(now, zone))


def person_day(session: Session, user_id: uuid.UUID, now: dt.datetime) -> PersonDay:
    """Rule 2: the person's day at ``now``, from the zone their profile saved (RLS)."""
    name = session.scalar(select(Profile.time_zone).where(Profile.user_id == user_id))
    return person_day_at(now, zone_for(name, user_id=user_id))
