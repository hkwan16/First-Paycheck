"""The salary check: a newer stub whose yearly pay differs from the saved salary
asks which to use (spec 005 rule 24c, issue 221).

The profile's ``salary_cents`` is a figure the person saved once, and the pay
schedule is the newest stub's (rule 25a), so after a stub on another schedule
or at other pay the two come from different paychecks. The API never writes
the stub's figure into the profile: ``GET /profile`` and ``PUT /profile``
report ``salary_review`` and the person answers with ``PUT /profile``. The
stub the salary was last compared with (``profiles.salary_pay_stub_id``)
keeps an answer through the next paycheck at the same pay and through a copy
of the same stub, because what is compared is the yearly pay each comes to.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Protocol

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from calc import pay_stub as pay_stub_calc
from calc.pay_dates import PERIODS, frequency_named
from calc.types import PayPeriods
from db.enums import PayFrequency
from db.models import Profile
from db.pay_stubs import find_pay_stub, newest_pay_stub

__all__ = ["SalaryReview", "load_salary_review", "salary_review"]


class StubPay(Protocol):
    """What the check reads from a confirmed stub (a ``PayStub`` row)."""

    @property
    def id(self) -> uuid.UUID: ...
    @property
    def pay_date(self) -> dt.date: ...
    @property
    def pay_frequency(self) -> PayFrequency | None: ...
    @property
    def gross_cents(self) -> int: ...


class SalaryReview(BaseModel):
    """The newest stub's yearly pay beside the saved salary, for the question."""

    pay_stub_id: uuid.UUID = Field(description="The newest current stub, which the answer names")
    pay_stub_date: dt.date
    frequency: PayFrequency
    periods_per_year: PayPeriods
    gross_cents: int
    annual_salary_cents: int = Field(
        description="The stub's gross pay times its pay periods a year (spec 005 rule 24a)"
    )
    salary_cents: int = Field(description="The salary saved in the profile")


def _annual(stub: StubPay | None) -> int | None:
    if stub is None or stub.pay_frequency is None:
        return None
    return pay_stub_calc.annual_salary_cents(stub.gross_cents, frequency_named(stub.pay_frequency))


def salary_review(
    salary_cents: int | None, newest: StubPay | None, compared: StubPay | None
) -> SalaryReview | None:
    """Rule 24c over rows already read: the question, or None when there is none.

    ``newest`` is the newest current stub and ``compared`` the one the salary
    was last compared with (current or superseded), each None when there is none.
    """
    annual = _annual(newest)
    if salary_cents is None or newest is None or newest.pay_frequency is None or annual is None:
        return None
    if annual == salary_cents or annual == _annual(compared):
        return None
    return SalaryReview(
        pay_stub_id=newest.id,
        pay_stub_date=newest.pay_date,
        frequency=newest.pay_frequency,
        periods_per_year=PERIODS[frequency_named(newest.pay_frequency)],
        gross_cents=newest.gross_cents,
        annual_salary_cents=annual,
        salary_cents=salary_cents,
    )


def load_salary_review(session: Session, profile: Profile | None) -> SalaryReview | None:
    """The user's salary question, reading their stubs in ``session``."""
    if profile is None or profile.salary_cents is None:
        return None
    compared = (
        None
        if profile.salary_pay_stub_id is None
        else find_pay_stub(session, profile.salary_pay_stub_id)
    )
    return salary_review(profile.salary_cents, newest_pay_stub(session), compared)
