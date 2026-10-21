"""Rate-limit windows are clock-aligned in UTC (spec 004 rule 5)."""

from __future__ import annotations

import datetime as dt

import pytest

from app.ratelimit import RateLimited, window_start

HOUR = dt.timedelta(hours=1)
PACIFIC = dt.timezone(dt.timedelta(hours=-7))


@pytest.mark.parametrize(
    ("now", "start"),
    [
        (
            dt.datetime(2026, 10, 21, 14, 59, 59, tzinfo=dt.UTC),
            dt.datetime(2026, 10, 21, 14, tzinfo=dt.UTC),
        ),
        (
            dt.datetime(2026, 10, 21, 15, 0, 0, tzinfo=dt.UTC),
            dt.datetime(2026, 10, 21, 15, tzinfo=dt.UTC),
        ),
        # 07:30 in UTC-7 is 14:30 UTC.
        (
            dt.datetime(2026, 10, 21, 7, 30, tzinfo=PACIFIC),
            dt.datetime(2026, 10, 21, 14, tzinfo=dt.UTC),
        ),
    ],
)
def test_window_start_is_the_utc_clock_hour(now: dt.datetime, start: dt.datetime) -> None:
    assert window_start(now, HOUR) == start


def test_rate_limited_carries_retry_after() -> None:
    error = RateLimited(30)
    assert (error.status_code, error.code) == (429, "rate_limited")
    assert error.headers == {"Retry-After": "30"}
