"""The next expected pay date (spec 007 rule 16). Pure date arithmetic.

``next_pay_date(frequency, anchor, today)`` is the first date of the pay
schedule strictly after ``today``. The schedule runs through ``anchor`` (the
latest confirmed pay stub's pay date) when there is one; without an anchor
weekly and biweekly pay is assumed to land one period from today, and
semimonthly and monthly pay on the 15th and the last day of the month.
"""

from __future__ import annotations

import calendar
import datetime as dt
from typing import Literal

__all__ = ["PERIODS", "PayFrequency", "frequency_for_periods", "next_pay_date"]

PayFrequency = Literal["weekly", "biweekly", "semimonthly", "monthly"]
PERIODS: dict[PayFrequency, int] = {"weekly": 52, "biweekly": 26, "semimonthly": 24, "monthly": 12}
_STEP_DAYS: dict[PayFrequency, int] = {"weekly": 7, "biweekly": 14}
# Enough months ahead to always find a semimonthly or monthly date.
_MONTHS_AHEAD = 3


def frequency_for_periods(periods: int) -> PayFrequency:
    for frequency, count in PERIODS.items():
        if count == periods:
            return frequency
    raise ValueError(f"no pay frequency has {periods} pay periods a year")


def _last_day(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def _on_day(year: int, month: int, day: int) -> dt.date:
    """``day`` of the month, clamped to the month's last day."""
    return dt.date(year, month, min(day, _last_day(year, month)))


def _months_from(today: dt.date) -> list[tuple[int, int]]:
    months = []
    year, month = today.year, today.month
    for _ in range(_MONTHS_AHEAD):
        months.append((year, month))
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return months


def _monthly_days(frequency: PayFrequency, anchor: dt.date | None) -> tuple[int, ...]:
    """Days of the month pay lands on (31 stands for "the last day")."""
    if anchor is None:
        return (15, 31) if frequency == "semimonthly" else (31,)
    day = anchor.day
    if frequency == "monthly":
        return (day,)
    if day == 15 or day == _last_day(anchor.year, anchor.month):
        return (15, 31)
    return (day, day + 15) if day <= 15 else (day - 15, day)


def next_pay_date(frequency: PayFrequency, anchor: dt.date | None, today: dt.date) -> dt.date:
    if frequency in _STEP_DAYS:
        step = _STEP_DAYS[frequency]
        if anchor is None:
            return today + dt.timedelta(days=step)
        # The smallest anchor + k * step (any integer k) after today.
        periods = (today - anchor).days // step + 1
        return anchor + dt.timedelta(days=periods * step)
    days = _monthly_days(frequency, anchor)
    candidates = sorted(
        _on_day(year, month, day) for year, month in _months_from(today) for day in days
    )
    return next(date for date in candidates if date > today)
