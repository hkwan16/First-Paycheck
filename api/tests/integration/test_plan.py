"""``GET /plan`` (spec 016 rules 1-8, examples 1-9)."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.deps import get_now
from tests.conftest import FixtureUser
from tests.support.plan_user import NOW, PlanUser, seed_plan_user

Client = Callable[[FixtureUser], TestClient]
ALL_CALCULATORS = ["emergency_fund", "k401_match", "health_plans", "w4"]


@pytest.fixture
def frozen_app(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_now] = lambda: NOW
    return app


@pytest.fixture
def plan_user(
    frozen_app: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    db_connection: Connection,
    seeded_citations: Connection,
) -> PlanUser:
    return seed_plan_user(db_connection, client_as(user_a), user_a.id)


def get_plan(client_as: Client, user: FixtureUser) -> dict[str, Any]:
    response = client_as(user).get("/plan")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def by_calculator(plan: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {decision["calculator"]: decision for decision in plan["decisions"]}


def follow(decision: dict[str, Any], key: str) -> Any:
    """The value at ``key`` (``inputs.x``, ``result.plans[0].name``) in a decision."""
    value: Any = decision
    for part in key.split("."):
        match = re.fullmatch(r"(\w+)(?:\[(\d+)\])?", part)
        assert match, key
        value = value[match.group(1)]
        if match.group(2) is not None:
            value = value[int(match.group(2))]
    return value


def test_plan_for_a_new_user_is_empty(
    frozen_app: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    plan = get_plan(client_as, user_a)
    assert plan == {
        "as_of": "2026-10-21",
        "calendar_through": "2027-01-19",
        "completeness": {"saved": [], "missing": ALL_CALCULATORS},
        "decisions": [],
        "goals": [],
        "calendar": [],
        "pay_stub": None,
    }


def test_plan_lists_current_decisions_in_calculator_order(
    plan_user: PlanUser, client_as: Client, user_a: FixtureUser
) -> None:
    plan = get_plan(client_as, user_a)
    assert [d["calculator"] for d in plan["decisions"]] == ALL_CALCULATORS
    assert plan["completeness"] == {"saved": ALL_CALCULATORS, "missing": []}
    k401 = by_calculator(plan)["k401_match"]
    assert k401["id"] == str(plan_user.k401_id)
    assert k401["version"] == 2
    assert k401["inputs"]["contribution_pct"] == "4.00"
    # Exactly what the decision route stores and returns.
    stored = client_as(user_a).get(f"/decisions/{plan_user.k401_id}").json()
    assert (k401["inputs"], k401["result"], k401["created_at"]) == (
        stored["inputs"],
        stored["result"],
        stored["created_at"],
    )


def test_every_figure_is_the_field_its_key_names(
    plan_user: PlanUser, client_as: Client, user_a: FixtureUser
) -> None:
    plan = get_plan(client_as, user_a)
    for decision in plan["decisions"]:
        assert decision["figures"], decision["calculator"]
        for figure in decision["figures"]:
            assert figure["value"] == follow(decision, figure["key"]), figure
    decisions = by_calculator(plan)
    assert [f["value"] for f in decisions["emergency_fund"]["figures"]] == [
        546_900,
        30_000,
        15_000,
        12,
        "39.13",
    ]
    assert [f["value"] for f in decisions["k401_match"]["figures"]] == [
        "4.00",
        "4.00",
        260_000,
        0,
    ]


def test_health_figures_follow_the_selected_plan_and_usage(
    plan_user: PlanUser, client_as: Client, user_a: FixtureUser
) -> None:
    health = by_calculator(get_plan(client_as, user_a))["health_plans"]
    assert [(f["key"], f["label"], f["kind"]) for f in health["figures"]] == [
        ("result.plans[0].name", "Plan", "text"),
        ("result.plans[0].medium_cost_cents", "Expected cost a year at medium use", "net_cost"),
        ("result.plans[0].annual_premium_cents", "Premiums a year", "money"),
        ("result.plans[0].worst_case_cents", "Worst case a year", "net_cost"),
    ]
    assert health["figures"][0]["value"] == "Bronze HSA"


def test_explanation_status_from_the_latest_row(
    plan_user: PlanUser, client_as: Client, user_a: FixtureUser
) -> None:
    decisions = by_calculator(get_plan(client_as, user_a))
    k401 = decisions["k401_match"]["explanation"]
    assert k401["status"] == "verified"
    assert k401["concept"].startswith("Your employer matches")
    assert [c["key"] for c in k401["citations"]] == ["k401.employer_match", "k401.deferral_limit"]
    assert all(c["url"].startswith("https://www.irs.gov/") for c in k401["citations"])
    health = decisions["health_plans"]["explanation"]
    assert (health["status"], [c["key"] for c in health["citations"]]) == (
        "fallback",
        ["health.hsa_limit"],
    )
    assert decisions["w4"]["explanation"]["status"] == "verified"
    assert decisions["emergency_fund"]["explanation"] == {
        "status": "none",
        "id": None,
        "concept": None,
        "text": None,
        "created_at": None,
        "citations": [],
    }


def test_calendar_is_the_next_90_days_of_upcoming_events(
    plan_user: PlanUser, client_as: Client, user_a: FixtureUser
) -> None:
    calendar = get_plan(client_as, user_a)["calendar"]
    assert [(e["due_at"], e["kind"], e["status"]) for e in calendar] == [
        ("2026-10-31", "election_check", "upcoming"),
        ("2026-10-31", "goal_contribution", "upcoming"),
        ("2026-10-31", "w4_submit", "upcoming"),
        ("2026-11-14", "enrollment_deadline", "upcoming"),
    ]
    election = calendar[0]
    assert election["decision_id"] == str(plan_user.k401_id)


def test_pay_stub_is_the_newest(
    plan_user: PlanUser, client_as: Client, user_a: FixtureUser
) -> None:
    stub = get_plan(client_as, user_a)["pay_stub"]
    assert stub is not None
    stub.pop("id")
    assert stub == {
        "employer_name": "Acme Corp",
        "pay_frequency": "semimonthly",
        "pay_date": "2026-10-15",
        "gross_cents": 270_833,
        "federal_withholding_cents": 29_776,
        "social_security_cents": 16_792,
        "medicare_cents": 3_927,
        "state_tax_cents": 9_814,
        "retirement_contribution_cents": 0,
        "medical_premium_cents": 6_250,
        "other_deductions_cents": 4_670,
        "net_cents": 199_604,
    }


def test_goals_match_get_goals(plan_user: PlanUser, client_as: Client, user_a: FixtureUser) -> None:
    goals = get_plan(client_as, user_a)["goals"]
    assert goals == client_as(user_a).get("/goals").json()
    [goal] = goals
    assert (goal["target_amount_cents"], goal["current_balance_cents"], goal["progress_pct"]) == (
        546_900,
        214_000,
        "39.13",
    )
    assert goal["account_id"] == str(plan_user.account_id)
