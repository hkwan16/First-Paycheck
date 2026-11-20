"""Entry limits through the routes (spec 007 rules 2a and 2b, issues 228 and 238).

``POST /decisions`` refuses what ``POST /calc/*`` refuses, with the path under
``inputs``; a decision stored before a limit existed still reads on every
screen that shows it, and its goal can still be adjusted.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel
from sqlalchemy import Connection

from app.deps import get_now
from calc.emergency_fund import EmergencyFundInput, emergency_fund
from calc.health_plans import HealthPlansInput, health_plans
from calc.types import STORED
from calc.w4 import W4Input, w4
from db.enums import CalculatorKind
from tests.conftest import FixtureUser
from tests.integration.test_goals import biweekly_with_stub
from tests.support.factories import make_decision, make_goal
from tests.unit.calc.test_health_plans_examples import A, B, payload

NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)
Client = Callable[[FixtureUser], TestClient]

W4_INPUTS: dict[str, Any] = {
    "salary_cents": 6_500_000,
    "pay_periods_per_year": 26,
    "filing_status": "single",
    "tax_year": 2026,
}
# Issue 238: Step 3 credits of $999,999, which the card calculated as no tax at all.
STEP_3_TYPO = {**W4_INPUTS, "dependents_credit_cents": 99_999_900}


@pytest.fixture
def frozen(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_now] = lambda: NOW
    return app


def test_a_decision_beyond_an_entry_limit_is_refused_under_inputs(
    client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    result = w4(W4Input.model_validate(STEP_3_TYPO, context=STORED)).model_dump(mode="json")
    response = client.post(
        "/decisions",
        json={"calculator": "w4", "inputs": STEP_3_TYPO, "result": result, "supersedes_id": None},
    )
    assert response.status_code == 422, response.text
    sentence = "Enter Step 3 credits up to $100,000.00 for the year."
    assert response.json()["error"] == {
        "code": "validation_error",
        "message": sentence,
        "details": {
            "errors": [{"path": ["inputs", "dependents_credit_cents"], "message": sentence}]
        },
    }
    assert client.get("/decisions").json()["items"] == []


def stored(
    connection: Connection, user: FixtureUser, kind: CalculatorKind, inputs: dict[str, Any]
) -> str:
    """A decision saved before today's limits, with the result its calculator gave then."""
    result: BaseModel
    match kind:
        case CalculatorKind.W4:
            result = w4(W4Input.model_validate(inputs, context=STORED))
        case CalculatorKind.HEALTH_PLANS:
            result = health_plans(HealthPlansInput.model_validate(inputs, context=STORED))
        case _:
            result = emergency_fund(EmergencyFundInput.model_validate(inputs, context=STORED))
    return str(
        make_decision(
            connection,
            user.id,
            kind,
            inputs,
            created_at=NOW - dt.timedelta(days=7),
            result=result.model_dump(mode="json"),
        )
    )


def test_a_decision_stored_beyond_todays_limits_still_reads(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    """Spec 007 rule 2b: review, the plan's figures and explain's context read it."""
    client = client_as(user_a)
    biweekly_with_stub(client, db_connection, user_a)
    w4_id = stored(db_connection, user_a, CalculatorKind.W4, STEP_3_TYPO)
    rich = {**A, "employer_hsa_cents": 9_999_900}
    health_id = stored(
        db_connection,
        user_a,
        CalculatorKind.HEALTH_PLANS,
        payload([rich, B], 6_500_000, 0, selected_plan_index=0),
    )

    decisions = client.get("/decisions")
    assert decisions.status_code == 200, decisions.text
    assert {item["current"]["id"] for item in decisions.json()["items"]} == {w4_id, health_id}
    for decision_id in (w4_id, health_id):
        one = client.get(f"/decisions/{decision_id}")
        assert one.status_code == 200, one.text
        # No explanation yet: a 404, not a 500 from rebuilding its context.
        assert client.get(f"/decisions/{decision_id}/explanation").status_code == 404
    plan = client.get("/plan")
    assert plan.status_code == 200, plan.text
    assert {decision["id"] for decision in plan.json()["decisions"]} == {w4_id, health_id}


def test_a_goal_from_a_fund_stored_beyond_the_limits_can_still_change(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    """The reprojection reads the stored inputs (spec 011 rule 17a); the new
    contribution is an entry and holds to its limit (rule 8a)."""
    client = client_as(user_a)
    biweekly_with_stub(client, db_connection, user_a)
    inputs = {
        "monthly_essentials_cents": 200_000_000,
        "target_months": 3,
        "current_balance_cents": 0,
        "monthly_contribution_cents": 5_000_000,
        "pay_periods_per_year": 26,
    }
    decision_id = stored(db_connection, user_a, CalculatorKind.EMERGENCY_FUND, inputs)
    goal_id = make_goal(
        db_connection,
        user_a.id,
        decision_id=decision_id,
        target_amount_cents=600_000_000,
        monthly_contribution_cents=5_000_000,
    )

    moved = client.patch(f"/goals/{goal_id}", json={"monthly_contribution_cents": 6_000_000})
    assert moved.status_code == 200, moved.text
    assert moved.json()["target_date"] is not None

    refused = client.patch(f"/goals/{goal_id}", json={"monthly_contribution_cents": 100_000_001})
    assert refused.status_code == 422, refused.text
    assert refused.json()["error"]["details"]["errors"] == [
        {
            "path": ["monthly_contribution_cents"],
            "message": "Enter a transfer up to $1,000,000.00 a month.",
        }
    ]
