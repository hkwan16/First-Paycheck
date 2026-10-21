"""Savings goals with their progress (spec 011 rules 15-17).

Goals are created and re-projected only by saving an emergency-fund decision
(``app/decision_effects.py``); these routes read them and make the small
changes a user makes between decisions: pause, mark reached, change the
contribution, link another account.
"""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal
from typing import Self

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import Now, UserSession
from app.errors import NotFound, error_responses
from app.types import UtcDateTime
from calc.emergency_fund import funded_pct
from calc.types import Cents
from db.enums import GoalKind, GoalStatus
from db.models import Account, BalanceSnapshot, Goal

router = APIRouter(prefix="/goals", tags=["goals"])


class GoalOut(BaseModel):
    id: uuid.UUID
    kind: GoalKind
    status: GoalStatus
    target_amount_cents: int
    monthly_contribution_cents: int
    account_id: uuid.UUID | None
    decision_id: uuid.UUID | None
    # The projected date of the last contribution; null when funded, not
    # reachable, or the contribution changed since the decision.
    target_date: dt.date | None
    reached_at: UtcDateTime | None
    # The linked account's latest balance, and that balance against the target.
    current_balance_cents: int | None
    progress_pct: Decimal | None
    created_at: UtcDateTime
    updated_at: UtcDateTime


class GoalPatch(BaseModel):
    """Any of the fields; one left out is unchanged."""

    model_config = ConfigDict(extra="forbid")

    status: GoalStatus | None = None
    monthly_contribution_cents: Cents | None = None
    # An account of the user's, or null to unlink.
    account_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _something_to_change(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("give at least one of status, monthly_contribution_cents, account_id")
        for name in ("status", "monthly_contribution_cents"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


def _latest_balance(session: Session, account_id: uuid.UUID | None) -> int | None:
    if account_id is None:
        return None
    return session.scalar(
        select(BalanceSnapshot.balance_cents)
        .where(BalanceSnapshot.account_id == account_id)
        .order_by(BalanceSnapshot.as_of.desc())
        .limit(1)
    )


def _out(session: Session, goal: Goal) -> GoalOut:
    balance = _latest_balance(session, goal.account_id)
    return GoalOut(
        id=goal.id,
        kind=goal.kind,
        status=goal.status,
        target_amount_cents=goal.target_amount_cents,
        monthly_contribution_cents=goal.monthly_contribution_cents,
        account_id=goal.account_id,
        decision_id=goal.decision_id,
        target_date=goal.target_date,
        reached_at=goal.reached_at,
        current_balance_cents=balance,
        progress_pct=funded_pct(balance, goal.target_amount_cents) if balance is not None else None,
        created_at=goal.created_at,
        updated_at=goal.updated_at,
    )


@router.get("", responses=error_responses(401))
def list_goals(session: UserSession) -> list[GoalOut]:
    """The user's goals, oldest first, with progress from the linked account."""
    goals = session.scalars(select(Goal).order_by(Goal.created_at, Goal.id))
    return [_out(session, goal) for goal in goals]


@router.patch("/{goal_id}", responses=error_responses(401, 404, 422))
def update_goal(goal_id: uuid.UUID, body: GoalPatch, session: UserSession, now: Now) -> GoalOut:
    """Pause, resume or mark a goal reached, change its contribution or its account."""
    goal = session.scalars(select(Goal).where(Goal.id == goal_id).with_for_update()).one_or_none()
    if goal is None:
        raise NotFound("Goal not found")
    fields = body.model_fields_set
    if "account_id" in fields:
        if body.account_id is not None and session.get(Account, body.account_id) is None:
            raise NotFound("Account not found")
        goal.account_id = body.account_id
    if body.monthly_contribution_cents is not None:
        if body.monthly_contribution_cents != goal.monthly_contribution_cents:
            # The projection belongs to the saved decision (spec 011 rule 17).
            goal.target_date = None
        goal.monthly_contribution_cents = body.monthly_contribution_cents
    if body.status is not None and body.status != goal.status:
        goal.status = body.status
        goal.reached_at = now if body.status is GoalStatus.REACHED else None
    session.flush()
    session.refresh(goal)  # updated_at comes from the trigger
    return _out(session, goal)
