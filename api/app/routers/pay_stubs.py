"""Confirmed pay stubs (spec 005 rules 24-24b)."""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal

from fastapi import APIRouter
from pydantic import BaseModel, computed_field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import UserSession
from app.errors import error_responses
from app.types import UtcDateTime
from calc import pay_stub as pay_stub_calc
from calc.pay_dates import frequency_named
from calc.types import ResultPercent
from db.enums import PayFrequency
from db.models import PayStub

router = APIRouter(prefix="/pay-stubs", tags=["pay-stubs"])


class PayStubOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    employer_name: str | None
    pay_frequency: PayFrequency | None
    pay_date: dt.date
    # The calendar year of pay_date: the stub's tax year.
    tax_year: int
    period_start: dt.date
    period_end: dt.date
    gross_cents: int
    federal_withholding_cents: int
    social_security_cents: int
    medicare_cents: int
    state_tax_cents: int
    retirement_contribution_cents: int
    medical_premium_cents: int
    other_deductions_cents: int
    net_cents: int
    created_at: UtcDateTime

    # Pydantic wraps the method in a property itself; an explicit @property
    # under the decorator is one mypy refuses (prop-decorator).
    @computed_field(
        description=(
            "Gross pay times the pay periods a year for pay_frequency, exact (spec 005 "
            "rule 24a); null without a pay frequency. Computed on read, never stored."
        )
    )
    def annual_salary_cents(self) -> int | None:
        frequency = None if self.pay_frequency is None else frequency_named(self.pay_frequency)
        return pay_stub_calc.annual_salary_cents(self.gross_cents, frequency)

    @computed_field(
        description=(
            "retirement_contribution_cents as a percentage of gross_cents, two places "
            "half up (spec 005 rule 24b): the 401(k) rate this paycheck shows. Null "
            "without a positive gross. Computed on read, never stored."
        )
    )
    def retirement_contribution_pct(self) -> ResultPercent | None:
        return pay_stub_calc.retirement_contribution_pct(
            self.retirement_contribution_cents, self.gross_cents
        )

    @classmethod
    def of(cls, stub: PayStub) -> PayStubOut:
        return cls.model_validate(stub, from_attributes=True)


NEWEST_FIRST = (PayStub.pay_date.desc(), PayStub.created_at.desc())


def newest_pay_stub(session: Session) -> PayStub | None:
    """The user's newest confirmed stub, in ``GET /pay-stubs`` order (spec 005 rule 24)."""
    return session.scalars(select(PayStub).order_by(*NEWEST_FIRST).limit(1)).first()


def newest_pay_stub_rate(session: Session) -> Decimal | None:
    """The 401(k) rate the newest confirmed stub shows (spec 005 rule 24b), the
    same figure as its ``PayStubOut.retirement_contribution_pct``; None without
    a stub or a positive gross. ``POST /explain`` states it (spec 008 rule 7a)."""
    stub = newest_pay_stub(session)
    if stub is None:
        return None
    return pay_stub_calc.retirement_contribution_pct(
        stub.retirement_contribution_cents, stub.gross_cents
    )


@router.get("", responses=error_responses(401))
def list_pay_stubs(session: UserSession) -> list[PayStubOut]:
    """The user's confirmed pay stubs, newest pay date first."""
    stubs = session.scalars(select(PayStub).order_by(*NEWEST_FIRST))
    return [PayStubOut.of(stub) for stub in stubs]
