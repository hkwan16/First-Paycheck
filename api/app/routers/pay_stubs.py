"""Confirmed pay stubs (spec 005 rule 24)."""

from __future__ import annotations

import datetime as dt
import uuid

from fastapi import APIRouter
from pydantic import BaseModel, computed_field
from sqlalchemy import select

from app.deps import UserSession
from app.errors import error_responses
from app.types import UtcDateTime
from calc import pay_stub as pay_stub_calc
from calc.pay_dates import frequency_named
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

    @classmethod
    def of(cls, stub: PayStub) -> PayStubOut:
        return cls.model_validate(stub, from_attributes=True)


@router.get("", responses=error_responses(401))
def list_pay_stubs(session: UserSession) -> list[PayStubOut]:
    """The user's confirmed pay stubs, newest pay date first."""
    stubs = session.scalars(
        select(PayStub).order_by(PayStub.pay_date.desc(), PayStub.created_at.desc())
    )
    return [PayStubOut.of(stub) for stub in stubs]
