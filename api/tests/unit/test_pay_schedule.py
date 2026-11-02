"""The one pay schedule (spec 005 rule 25a, issue 198), worked examples."""

from __future__ import annotations

import datetime as dt

import pytest

from app.pay_schedule import PaySchedule, resolve_pay_schedule
from db.enums import PayFrequency
from db.models import PayStub, Profile


def stub(frequency: PayFrequency | None, pay_date: dt.date = dt.date(2026, 10, 15)) -> PayStub:
    return PayStub(pay_frequency=frequency, pay_date=pay_date)


def profile(frequency: PayFrequency | None) -> Profile:
    return Profile(pay_frequency=frequency)


def test_the_stub_wins_over_the_profile() -> None:
    """Issue 198's account: plan details kept every two weeks, the stub is paid twice a month."""
    assert resolve_pay_schedule(
        stub(PayFrequency.SEMIMONTHLY), profile(PayFrequency.BIWEEKLY)
    ) == PaySchedule(
        frequency=PayFrequency.SEMIMONTHLY,
        periods_per_year=24,
        source="pay_stub",
        pay_stub_date=dt.date(2026, 10, 15),
    )


def test_the_profile_when_the_stub_prints_none() -> None:
    assert resolve_pay_schedule(stub(None), profile(PayFrequency.BIWEEKLY)) == PaySchedule(
        frequency=PayFrequency.BIWEEKLY, periods_per_year=26, source="profile", pay_stub_date=None
    )


def test_the_profile_without_a_stub() -> None:
    assert resolve_pay_schedule(None, profile(PayFrequency.WEEKLY)) == PaySchedule(
        frequency=PayFrequency.WEEKLY, periods_per_year=52, source="profile", pay_stub_date=None
    )


def test_the_stub_without_a_profile_entry() -> None:
    expected = PaySchedule(
        frequency=PayFrequency.MONTHLY,
        periods_per_year=12,
        source="pay_stub",
        pay_stub_date=dt.date(2026, 10, 30),
    )
    monthly = stub(PayFrequency.MONTHLY, dt.date(2026, 10, 30))
    assert resolve_pay_schedule(monthly, profile(None)) == expected
    assert resolve_pay_schedule(monthly, None) == expected


@pytest.mark.parametrize("newest", [None, stub(None)], ids=["no stub", "no schedule"])
@pytest.mark.parametrize("saved", [None, profile(None)], ids=["no profile", "no entry"])
def test_no_schedule(newest: PayStub | None, saved: Profile | None) -> None:
    assert resolve_pay_schedule(newest, saved) is None
