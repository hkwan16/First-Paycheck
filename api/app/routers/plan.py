"""The plan, its calendar file and its PDF export (spec 016)."""

from __future__ import annotations

from fastapi import APIRouter

from app.deps import Now, UserSession
from app.errors import error_responses
from app.plan import PlanOut, build_plan

router = APIRouter(prefix="/plan", tags=["plan"])


@router.get("", responses=error_responses(401))
def get_plan(session: UserSession, now: Now) -> PlanOut:
    """Every current decision with its figures, the goals, the next 90 days and the pay stub."""
    return build_plan(session, now.date())
