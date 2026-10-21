"""calc/pay_dates.py: the next expected pay date (spec 007 rule 16)."""

from __future__ import annotations

import datetime as dt

import pytest

from calc.pay_dates import PayFrequency, add_months, frequency_for_periods, next_pay_date

D = dt.date


@pytest.mark.parametrize(
    ("frequency", "anchor", "today", "expected"),
    [
        ("biweekly", D(2026, 10, 16), D(2026, 10, 21), D(2026, 10, 30)),
        ("biweekly", D(2026, 10, 30), D(2026, 10, 21), D(2026, 10, 30)),
        ("biweekly", D(2026, 1, 2), D(2026, 10, 21), D(2026, 10, 23)),
        ("weekly", D(2026, 10, 16), D(2026, 10, 23), D(2026, 10, 30)),
        ("semimonthly", D(2026, 10, 15), D(2026, 10, 21), D(2026, 10, 31)),
        ("semimonthly", D(2026, 10, 31), D(2026, 10, 31), D(2026, 11, 15)),
        ("semimonthly", D(2026, 9, 30), D(2026, 10, 1), D(2026, 10, 15)),
        ("semimonthly", D(2026, 10, 10), D(2026, 10, 21), D(2026, 10, 25)),
        ("semimonthly", D(2026, 10, 20), D(2026, 10, 21), D(2026, 11, 5)),
        ("semimonthly", D(2026, 1, 16), D(2026, 2, 2), D(2026, 2, 16)),
        ("monthly", D(2026, 1, 31), D(2026, 2, 10), D(2026, 2, 28)),
        ("monthly", D(2026, 1, 31), D(2026, 2, 28), D(2026, 3, 31)),
        ("monthly", D(2026, 1, 15), D(2026, 12, 20), D(2027, 1, 15)),
        ("monthly", None, D(2026, 10, 21), D(2026, 10, 31)),
        ("monthly", None, D(2026, 10, 31), D(2026, 11, 30)),
        ("biweekly", None, D(2026, 10, 21), D(2026, 11, 4)),
        ("weekly", None, D(2026, 10, 21), D(2026, 10, 28)),
        ("semimonthly", None, D(2026, 10, 21), D(2026, 10, 31)),
        ("semimonthly", None, D(2026, 10, 2), D(2026, 10, 15)),
        ("semimonthly", None, D(2026, 12, 31), D(2027, 1, 15)),
    ],
)
def test_next_pay_date(
    frequency: PayFrequency, anchor: dt.date | None, today: dt.date, expected: dt.date
) -> None:
    assert next_pay_date(frequency, anchor, today) == expected


@pytest.mark.parametrize(
    ("periods", "frequency"),
    [(52, "weekly"), (26, "biweekly"), (24, "semimonthly"), (12, "monthly")],
)
def test_frequency_for_periods(periods: int, frequency: str) -> None:
    assert frequency_for_periods(periods) == frequency


def test_frequency_for_unknown_periods_fails() -> None:
    with pytest.raises(ValueError, match="13"):
        frequency_for_periods(13)


@pytest.mark.parametrize("frequency", ["weekly", "biweekly", "semimonthly", "monthly"])
def test_always_strictly_after_today(frequency: PayFrequency) -> None:
    anchor = D(2026, 1, 9)
    day = D(2026, 1, 1)
    while day < D(2027, 1, 1):
        result = next_pay_date(frequency, anchor, day)
        assert day < result <= day + dt.timedelta(days=31)
        day += dt.timedelta(days=1)


@pytest.mark.parametrize(
    ("start", "months", "expected"),
    [
        (D(2026, 10, 30), 0, D(2026, 10, 30)),
        (D(2026, 10, 30), 3, D(2027, 1, 30)),
        (D(2026, 10, 30), 14, D(2027, 12, 30)),
        (D(2026, 11, 30), 3, D(2027, 2, 28)),
        (D(2027, 11, 30), 3, D(2028, 2, 29)),
        (D(2026, 1, 31), 1, D(2026, 2, 28)),
    ],
)
def test_add_months_clamps_to_the_month_end(start: dt.date, months: int, expected: dt.date) -> None:
    assert add_months(start, months) == expected


def test_add_months_refuses_negative_counts() -> None:
    with pytest.raises(ValueError, match="-1"):
        add_months(D(2026, 1, 1), -1)
