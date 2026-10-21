"""Confirmed health plan options (spec 013 rules 14-15)."""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select

from app.deps import UserSession
from app.errors import error_responses
from app.types import UtcDateTime
from db.enums import PlanKind
from db.models import BenefitsPlan, Document

router = APIRouter(prefix="/benefits-plans", tags=["benefits"])


class BenefitsPlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    # The benefits summary the plan was confirmed from; null when typed by hand.
    document_id: uuid.UUID | None
    name: str
    kind: PlanKind
    premium_per_period_cents: int
    deductible_cents: int
    oop_max_cents: int
    coinsurance_pct: Decimal
    employer_hsa_cents: int
    enrollment_deadline: dt.date | None
    created_at: UtcDateTime

    @classmethod
    def of(cls, plan: BenefitsPlan) -> BenefitsPlanOut:
        return cls.model_validate(plan)


@router.get("", responses=error_responses(401))
def list_benefits_plans(session: UserSession) -> list[BenefitsPlanOut]:
    """The user's confirmed plans: the most recently confirmed summary first, each
    summary's plans in the order it lists them."""
    confirmed = func.coalesce(Document.confirmed_at, BenefitsPlan.created_at)
    plans = session.scalars(
        select(BenefitsPlan)
        .outerjoin(Document, Document.id == BenefitsPlan.document_id)
        .order_by(
            confirmed.desc(),
            BenefitsPlan.document_id,
            BenefitsPlan.position,
            BenefitsPlan.id,
        )
    )
    return [BenefitsPlanOut.of(plan) for plan in plans]
