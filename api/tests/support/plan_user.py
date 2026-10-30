"""Spec 016's plan user: a semimonthly earner with all four decisions saved.

``seed_plan_user`` saves the decisions through the API (so their calendar
events and goal come from the real side effects) with the request clock frozen
at ``NOW``, and writes the explanations directly so their text is fixed. The
app must already return ``NOW`` from ``get_now`` (the ``frozen_app`` fixture
in the plan tests does that).
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import Connection
from sqlalchemy.orm import Session

from app.db import user_session_for
from app.routers.explain import current_setup
from db.enums import AccountKind, AccountRole
from db.models import Decision, Explanation
from llm.gateway import EXPLAIN_PROMPT
from llm.prompts import load_prompt
from retrieval.citations import for_calculator
from tests.support.factories import (
    make_account,
    make_document,
    make_item,
    make_pay_stub,
    make_snapshot,
)
from verify.fallback import FALLBACK_VERSION

NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)

SALARY_CENTS = 6_500_000
PERIODS = 24

EMERGENCY_FUND: dict[str, Any] = {
    "monthly_essentials_cents": 182_300,
    "target_months": 3,
    "current_balance_cents": 214_000,
    "monthly_contribution_cents": 30_000,
    "pay_periods_per_year": PERIODS,
}
K401_V1: dict[str, Any] = {
    "salary_cents": SALARY_CENTS,
    "pay_periods_per_year": PERIODS,
    "match_tiers": [{"employee_pct_upto": "4", "employer_pct": "100"}],
    "contribution_pct": "3",
    "tax_year": 2026,
    "filing_status": "single",
    "age": 25,
}
K401_V2: dict[str, Any] = {**K401_V1, "contribution_pct": "4"}
# Spec 012's plans A and B at 24 pay periods.
BRONZE_HSA: dict[str, Any] = {
    "name": "Bronze HSA",
    "kind": "hdhp",
    "premium_per_period_cents": 2_500,
    "deductible_cents": 170_000,
    "coinsurance_pct": "20",
    "oop_max_cents": 400_000,
    "employer_hsa_cents": 75_000,
}
GOLD_PPO: dict[str, Any] = {
    "name": "Gold PPO",
    "kind": "ppo",
    "premium_per_period_cents": 6_250,
    "deductible_cents": 50_000,
    "coinsurance_pct": "10",
    "oop_max_cents": 300_000,
    "employer_hsa_cents": 0,
}
HEALTH_PLANS: dict[str, Any] = {
    "plans": [BRONZE_HSA, GOLD_PPO],
    "pay_periods_per_year": PERIODS,
    "salary_cents": SALARY_CENTS,
    "filing_status": "single",
    "tax_year": 2026,
    "employee_hsa_cents": 0,
    "expected_usage": "medium",
    "selected_plan_index": 0,
    "enrollment_deadline": "2026-11-14",
}
W4: dict[str, Any] = {
    "salary_cents": SALARY_CENTS,
    "pay_periods_per_year": PERIODS,
    "filing_status": "single",
    "tax_year": 2026,
    "k401_contribution_pct": "4",
    "health_premium_per_paycheck_cents": 2_500,
}

CALC_ROUTES = {
    "emergency_fund": "/calc/emergency-fund",
    "k401_match": "/calc/401k-match",
    "health_plans": "/calc/health-plans",
    "w4": "/calc/w4",
}


@dataclass(frozen=True)
class PlanUser:
    emergency_fund_id: uuid.UUID
    k401_v1_id: uuid.UUID
    k401_id: uuid.UUID
    health_plans_id: uuid.UUID
    w4_id: uuid.UUID
    account_id: uuid.UUID


def save_decision(
    client: TestClient,
    calculator: str,
    inputs: dict[str, Any],
    supersedes_id: uuid.UUID | None = None,
) -> uuid.UUID:
    result = client.post(CALC_ROUTES[calculator], json=inputs)
    assert result.status_code == 200, result.text
    saved = client.post(
        "/decisions",
        json={
            "calculator": calculator,
            "inputs": inputs,
            "result": result.json(),
            "supersedes_id": str(supersedes_id) if supersedes_id else None,
        },
    )
    assert saved.status_code == 201, saved.text
    return uuid.UUID(saved.json()["decision_id"])


def current_digest(session: Session, decision_id: uuid.UUID) -> str:
    """The digest a run would store now (spec 008 rule 19a), so the fixed rows read
    as current."""
    decision = session.get(Decision, decision_id)
    assert decision is not None
    citations = for_calculator(session, decision.calculator, int(decision.inputs["tax_year"]))
    return current_setup(session, decision, citations).digest


def explanation(
    session: Session,
    user_id: uuid.UUID,
    decision_id: uuid.UUID,
    *,
    attempt: int,
    verified: bool,
    fallback: bool,
    concept: str,
    text: str,
    citations: list[str],
) -> Explanation:
    return Explanation(
        user_id=user_id,
        decision_id=decision_id,
        attempt=attempt,
        retries=min(attempt - 1, 1),
        concept=concept,
        text=text,
        numbers=[],
        what_ifs=[],
        citations=citations,
        prompt_version=FALLBACK_VERSION if fallback else load_prompt(*EXPLAIN_PROMPT).version,
        verified=verified,
        fallback=fallback,
        verification={},
        context_digest=current_digest(session, decision_id),
    )


def explain(connection: Connection, user_id: uuid.UUID, plan: PlanUser) -> None:
    """The fixed explanations of spec 016's plan user (rows added in this order)."""
    with user_session_for(user_id, bind=connection) as session:
        session.add_all(
            [
                explanation(
                    session,
                    user_id,
                    plan.k401_id,
                    attempt=1,
                    verified=False,
                    fallback=False,
                    concept="A first draft the verifier rejected.",
                    text="This draft cited $9,999.00, which the calculator never produced.",
                    citations=["k401.employer_match"],
                ),
            ]
        )
        session.flush()
        session.add_all(
            [
                explanation(
                    session,
                    user_id,
                    plan.k401_id,
                    attempt=2,
                    verified=True,
                    fallback=False,
                    concept="Your employer matches what you put into your 401(k), up to a limit.",
                    text=(
                        "Contributing 4% earns the full employer match of $2,600.00 a year,"
                        " so no match is left on the table."
                    ),
                    citations=["k401.employer_match", "k401.deferral_limit"],
                ),
                explanation(
                    session,
                    user_id,
                    plan.health_plans_id,
                    attempt=3,
                    verified=False,
                    fallback=True,
                    concept="Comparing health plans by what each costs you in a year.",
                    text="The calculator's comparison of your two plans, without commentary.",
                    citations=["health.hsa_limit"],
                ),
                explanation(
                    session,
                    user_id,
                    plan.w4_id,
                    attempt=1,
                    verified=True,
                    fallback=False,
                    concept="Your Form W-4 sets the federal tax taken from each paycheck.",
                    text="With your 401(k) and premium counted, the withholding covers the year.",
                    citations=["w4.percentage_method"],
                ),
            ]
        )
        session.flush()


def seed_plan_user(connection: Connection, client: TestClient, user_id: uuid.UUID) -> PlanUser:
    profile = client.put(
        "/profile",
        json={
            "salary_cents": SALARY_CENTS,
            "pay_frequency": "semimonthly",
            "filing_status": "single",
        },
    )
    assert profile.status_code == 200, profile.text
    make_pay_stub(
        connection,
        user_id,
        make_document(connection, user_id, with_blob=False),
        pay_date=dt.date(2026, 9, 30),
        period_start=dt.date(2026, 9, 16),
        period_end=dt.date(2026, 9, 30),
    )
    make_pay_stub(connection, user_id, make_document(connection, user_id, with_blob=False))
    item = make_item(connection, user_id)
    account = make_account(
        connection,
        user_id,
        item,
        kind=AccountKind.SAVINGS,
        role=AccountRole.EMERGENCY_FUND,
        name="Chase Savings",
        provider_account_id="savings-7730",
        mask="7730",
    )
    make_snapshot(connection, user_id, account, balance_cents=214_000)

    fund = save_decision(client, "emergency_fund", EMERGENCY_FUND)
    k401_v1 = save_decision(client, "k401_match", K401_V1)
    k401_v2 = save_decision(client, "k401_match", K401_V2, supersedes_id=k401_v1)
    health = save_decision(client, "health_plans", HEALTH_PLANS)
    w4 = save_decision(client, "w4", W4)
    plan = PlanUser(
        emergency_fund_id=fund,
        k401_v1_id=k401_v1,
        k401_id=k401_v2,
        health_plans_id=health,
        w4_id=w4,
        account_id=account,
    )
    explain(connection, user_id, plan)
    return plan
