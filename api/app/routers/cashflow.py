"""Every number of the cash-flow diagram for a period (spec 010 part A, amendment 16).

Stage 1 (gross pay to deductions and take-home) comes from the confirmed pay
stubs through the pure ``calc.cashflow.withholding``; stages 2 and 3 (take-home
to buckets to categories) are the spending summary of the same period. The
client draws; it never adds.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.deps import Now, UserSession
from app.errors import error_responses
from app.routers.spending import SpendingSummary, period, summary_for
from calc.cashflow import StubFlow, withholding
from calc.pay_stub import PayStubAmounts
from db.models import PayStub

router = APIRouter(prefix="/cashflow", tags=["spending"])


class PayStubFlow(StubFlow):
    pay_stub_id: uuid.UUID
    pay_date: dt.date


class WithholdingTotal(StubFlow):
    # Confirmed pay stubs paid in the period.
    paycheck_count: int


class CashFlow(BaseModel):
    start: dt.date
    end: dt.date
    # Each stub paid in the period, by pay date.
    pay_stubs: list[PayStubFlow]
    # The period's stubs summed line by line.
    withholding: WithholdingTotal
    # Exactly what GET /spending/summary returns for the same period.
    spending: SpendingSummary


def _amounts(stub: PayStub) -> PayStubAmounts:
    return PayStubAmounts(
        gross_cents=stub.gross_cents,
        federal_withholding_cents=stub.federal_withholding_cents,
        social_security_cents=stub.social_security_cents,
        medicare_cents=stub.medicare_cents,
        state_tax_cents=stub.state_tax_cents,
        retirement_contribution_cents=stub.retirement_contribution_cents,
        medical_premium_cents=stub.medical_premium_cents,
        other_deductions_cents=stub.other_deductions_cents,
        net_cents=stub.net_cents,
    )


@router.get("", responses=error_responses(401, 422))
def get_cashflow(
    session: UserSession,
    now: Now,
    start: Annotated[dt.date | None, Query(description="First day, inclusive")] = None,
    end: Annotated[dt.date | None, Query(description="Last day, inclusive")] = None,
) -> CashFlow:
    """Gross-to-net lines of each pay stub and the spending summary; the last full UTC
    month by default."""
    first, last = period(start, end, now.date())
    stubs = list(
        session.scalars(
            select(PayStub)
            .where(PayStub.pay_date.between(first, last))
            .order_by(PayStub.pay_date, PayStub.id)
        )
    )
    flow = withholding([_amounts(stub) for stub in stubs])
    return CashFlow(
        start=first,
        end=last,
        pay_stubs=[
            PayStubFlow(pay_stub_id=stub.id, pay_date=stub.pay_date, **one.model_dump())
            for stub, one in zip(stubs, flow.stubs, strict=True)
        ],
        withholding=WithholdingTotal(paycheck_count=flow.paycheck_count, **flow.total.model_dump()),
        spending=summary_for(session, first, last),
    )
