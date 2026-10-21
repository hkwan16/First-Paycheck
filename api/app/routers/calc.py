"""Stateless calculators (technical spec, Calculators). They save nothing;
``POST /decisions`` saves the result the user picks."""

from __future__ import annotations

from fastapi import APIRouter

from app.auth import CurrentUser
from app.errors import error_responses
from calc.emergency_fund import EmergencyFundInput, EmergencyFundResult, emergency_fund
from calc.k401 import K401MatchInput, K401MatchResult, k401_match

router = APIRouter(prefix="/calc", tags=["calc"])


@router.post("/401k-match", responses=error_responses(401, 422))
def calc_401k_match(body: K401MatchInput, user: CurrentUser) -> K401MatchResult:
    """The 401(k) match calculator (spec 006): full-match percentage, the match
    at the current and full-match percentages, dollars missed and the
    per-paycheck cost before and after federal income tax."""
    del user  # signed-in users only; the calculator reads nothing of theirs
    return k401_match(body)


@router.post("/emergency-fund", responses=error_responses(401, 422))
def calc_emergency_fund(body: EmergencyFundInput, user: CurrentUser) -> EmergencyFundResult:
    """The emergency fund calculator (spec 011): the target from monthly
    essentials, the shortfall, months to the target at the monthly
    contribution and that contribution per paycheck."""
    del user  # signed-in users only; the calculator reads nothing of theirs
    return emergency_fund(body)
