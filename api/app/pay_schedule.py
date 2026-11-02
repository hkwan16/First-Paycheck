"""The user's pay schedule: one resolver for every reader (spec 005 rule 25a, issue 198).

The newest current confirmed stub's ``pay_frequency`` when it prints one, else
the profile's, else none. A confirmed stub is what payroll paid on; the
profile's entry is what the person typed once, which nothing updates, so a
stub confirmed later must win over it. ``GET /profile`` and ``PUT /profile``
return it, the cards build their calculator inputs from it, and the decision
side effects date the next paycheck with it (spec 007 rule 16).
"""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.routers.pay_stubs import newest_pay_stub
from calc.pay_dates import PERIODS, frequency_named
from calc.types import PayPeriods
from db.enums import PayFrequency
from db.models import PayStub, Profile

__all__ = ["PaySchedule", "pay_schedule", "resolve_pay_schedule"]


class PaySchedule(BaseModel):
    frequency: PayFrequency
    periods_per_year: PayPeriods
    source: Literal["pay_stub", "profile"] = Field(
        description="Where the schedule comes from: the newest stub, or the profile's entry"
    )
    pay_stub_date: dt.date | None = Field(
        description="The pay date of the stub it comes from; null when it is the profile's"
    )


def _schedule(
    frequency: PayFrequency, source: Literal["pay_stub", "profile"], pay_stub_date: dt.date | None
) -> PaySchedule:
    return PaySchedule(
        frequency=frequency,
        periods_per_year=PERIODS[frequency_named(frequency)],
        source=source,
        pay_stub_date=pay_stub_date,
    )


def resolve_pay_schedule(newest: PayStub | None, profile: Profile | None) -> PaySchedule | None:
    """Rule 25a over rows already read: the newest stub's schedule, else the profile's."""
    if newest is not None and newest.pay_frequency is not None:
        return _schedule(newest.pay_frequency, "pay_stub", newest.pay_date)
    if profile is not None and profile.pay_frequency is not None:
        return _schedule(profile.pay_frequency, "profile", None)
    return None


def pay_schedule(session: Session, profile: Profile | None) -> PaySchedule | None:
    """The user's pay schedule, reading their newest current stub in ``session``."""
    return resolve_pay_schedule(newest_pay_stub(session), profile)
