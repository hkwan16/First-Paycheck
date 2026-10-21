"""Detected recurring charges: list them, rename one or say what it is (spec 009 rules 17-18).

The ``recurring.detect`` job writes the rows and owns ``status``; these routes
change only what belongs to the user: ``user_status`` and the display name.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated, Self

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import select

from app.deps import UserSession
from app.errors import NotFound, error_responses
from app.types import UtcDateTime
from db.enums import RecurringCadence, RecurringStatus, RecurringUserStatus
from db.models import RecurringCharge

router = APIRouter(prefix="/recurring", tags=["recurring"])

DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class RecurringChargeOut(BaseModel):
    id: uuid.UUID
    merchant_norm: str
    merchant_clean: str
    cadence: RecurringCadence
    # The median of the newest charges; money out, so positive.
    typical_amount_cents: int
    first_seen: dt.date
    last_seen: dt.date
    # The detector's flag: new, changed and stopped are for the next check-in.
    status: RecurringStatus
    # What the user said: confirmed, ignored (not recurring) or cancelled.
    user_status: RecurringUserStatus | None
    updated_at: UtcDateTime


class RecurringPatch(BaseModel):
    """Omitted fields are unchanged; ``user_status: null`` clears it."""

    model_config = ConfigDict(extra="forbid")

    user_status: RecurringUserStatus | None = None
    merchant_clean: DisplayName | None = Field(default=None, description="A new display name")

    @model_validator(mode="after")
    def _name_not_null(self) -> Self:
        if "merchant_clean" in self.model_fields_set and self.merchant_clean is None:
            raise ValueError("merchant_clean cannot be null; omit it to keep the name")
        return self


def _out(charge: RecurringCharge) -> RecurringChargeOut:
    return RecurringChargeOut(
        id=charge.id,
        merchant_norm=charge.merchant_norm,
        merchant_clean=charge.merchant_clean,
        cadence=charge.cadence,
        typical_amount_cents=charge.typical_amount_cents,
        first_seen=charge.first_seen,
        last_seen=charge.last_seen,
        status=charge.status,
        user_status=charge.user_status,
        updated_at=charge.updated_at,
    )


@router.get("", responses=error_responses(401))
def list_recurring(session: UserSession) -> list[RecurringChargeOut]:
    """Every detected charge, ignored ones included, by name."""
    charges = session.scalars(
        select(RecurringCharge).order_by(
            RecurringCharge.merchant_clean, RecurringCharge.cadence, RecurringCharge.id
        )
    )
    return [_out(charge) for charge in charges]


@router.patch("/{charge_id}", responses=error_responses(401, 404, 422))
def update_recurring(
    charge_id: uuid.UUID, body: RecurringPatch, session: UserSession
) -> RecurringChargeOut:
    """Rename a charge, or mark it confirmed, not recurring (ignored) or cancelled."""
    charge = session.get(RecurringCharge, charge_id)
    if charge is None:
        raise NotFound("Recurring charge not found")
    if "user_status" in body.model_fields_set:
        charge.user_status = body.user_status
    if body.merchant_clean is not None:
        charge.merchant_clean = body.merchant_clean
    session.flush()
    session.refresh(charge)
    return _out(charge)
