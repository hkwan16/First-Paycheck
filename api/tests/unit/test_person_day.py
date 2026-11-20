"""The person's day (spec 019 rules 1-4, examples 1-5)."""

from __future__ import annotations

import datetime as dt
import logging
from zoneinfo import ZoneInfo

import pytest

from db.person_day import (
    DEFAULT_TIME_ZONE,
    is_time_zone,
    person_day_at,
    zone_for,
)

PACIFIC = ZoneInfo("America/Los_Angeles")
EASTERN = ZoneInfo("America/New_York")


def at(text: str) -> dt.datetime:
    return dt.datetime.fromisoformat(text).replace(tzinfo=dt.UTC)


def test_today_is_the_persons_date() -> None:
    now = at("2026-11-10T06:27")
    assert person_day_at(now, PACIFIC).today == dt.date(2026, 11, 9)
    assert person_day_at(now, EASTERN).today == dt.date(2026, 11, 10)
    assert person_day_at(now, ZoneInfo("UTC")).today == dt.date(2026, 11, 10)


def test_today_across_the_dst_change() -> None:
    assert person_day_at(at("2026-11-01T05:30"), EASTERN).today == dt.date(2026, 11, 1)
    assert person_day_at(at("2026-11-01T05:30"), PACIFIC).today == dt.date(2026, 10, 31)
    assert person_day_at(at("2026-11-01T07:30"), PACIFIC).today == dt.date(2026, 11, 1)


def test_month_is_the_first_day_of_todays_month() -> None:
    day = person_day_at(at("2026-12-01T05:00"), PACIFIC)
    assert day.today == dt.date(2026, 11, 30)
    assert day.month == dt.date(2026, 11, 1)


def test_day_of_dates_a_stored_instant_in_the_zone() -> None:
    day = person_day_at(at("2026-11-20T12:00"), PACIFIC)
    assert day.day_of(at("2026-11-15T05:00")) == dt.date(2026, 11, 14)
    assert day.day_of(at("2026-11-15T08:00")) == dt.date(2026, 11, 15)


def test_start_of_day() -> None:
    day = person_day_at(at("2026-11-20T12:00"), PACIFIC)
    assert day.start_of(dt.date(2026, 11, 1)) == at("2026-11-01T07:00")
    assert day.start_of(dt.date(2026, 11, 2)) == at("2026-11-02T08:00")


def test_start_of_a_day_that_begins_in_a_gap() -> None:
    # Havana springs forward at midnight: 2026-03-08 00:00 does not exist there,
    # so the day starts at 01:00 CDT (05:00 UTC).
    havana = person_day_at(at("2026-03-10T12:00"), ZoneInfo("America/Havana"))
    assert havana.start_of(dt.date(2026, 3, 8)) == at("2026-03-08T05:00")
    assert havana.day_of(havana.start_of(dt.date(2026, 3, 8))) == dt.date(2026, 3, 8)


def test_a_naive_instant_is_refused() -> None:
    # A wall time with no zone could be any of 38 hours of instants.
    naive = at("2026-11-10T06:27").replace(tzinfo=None)
    with pytest.raises(ValueError, match="time zone"):
        person_day_at(naive, PACIFIC)
    with pytest.raises(ValueError, match="time zone"):
        person_day_at(at("2026-11-10T06:27"), PACIFIC).day_of(naive)


def test_zone_for_unset_or_unknown_is_the_default(caplog: pytest.LogCaptureFixture) -> None:
    assert DEFAULT_TIME_ZONE == "America/New_York"
    assert zone_for(None) == EASTERN
    assert zone_for("America/Los_Angeles") == PACIFIC
    with caplog.at_level(logging.WARNING, logger="db.person_day"):
        assert zone_for("Mars/Olympus") == EASTERN
    assert "not a known time zone" in caplog.text
    # The name came from a browser: it is never logged.
    assert "Mars/Olympus" not in caplog.text


@pytest.mark.parametrize(
    ("name", "known"),
    [
        ("America/Los_Angeles", True),
        ("Asia/Calcutta", True),
        ("US/Pacific", True),
        ("UTC", True),
        ("Asia/Kathmandu", True),
        ("", False),
        ("Mars/Olympus", False),
        ("America/New_York ", False),
        ("america/new_york", False),
        ("EST5EDT,M3.2.0,M11.1.0", False),
        ("../etc/passwd", False),
        ("/usr/share/zoneinfo/UTC", False),
        ("A" * 65, False),
    ],
)
def test_is_time_zone(name: str, known: bool) -> None:
    assert is_time_zone(name) is known
