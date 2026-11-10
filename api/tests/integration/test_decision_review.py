"""Saved decisions that need review, through the routes (spec 007 rules 19a-19e, issue 222).

Issue 222's account: stub-01 confirmed (every two weeks), plan details saved
at $95,000.10 against it, and the 401(k), health plan and W-4 saved through
``POST /decisions`` on 26 paychecks. Then the Acme stub (twice a month) is
confirmed through the confirm route, as the e2e account did.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import Connection

from tests.conftest import FixtureUser
from tests.support.pay_stub_copies import STUB_01, confirm_stub
from tests.support.plan_user import save_decision

Client = Callable[[FixtureUser], TestClient]

OLD_SALARY = 9_500_010
PROFILE: dict[str, Any] = {
    "salary_cents": OLD_SALARY,
    "filing_status": "single",
    "match_tiers": [
        {"employee_pct_upto": "3", "employer_pct": "100"},
        {"employee_pct_upto": "5", "employer_pct": "50"},
    ],
    "birth_year": 2002,
}
K401: dict[str, Any] = {
    "salary_cents": OLD_SALARY,
    "pay_periods_per_year": 26,
    "match_tiers": PROFILE["match_tiers"],
    "contribution_pct": "5.00",
    "tax_year": 2026,
    "filing_status": "single",
    "age": 24,
}
HEALTH: dict[str, Any] = {
    "plans": [
        {
            "name": "Value HMO",
            "kind": "hmo",
            "premium_per_period_cents": 400,
            "deductible_cents": 150_000,
            "coinsurance_pct": "20",
            "oop_max_cents": 400_000,
            "employer_hsa_cents": 0,
        }
    ],
    "pay_periods_per_year": 26,
    "salary_cents": OLD_SALARY,
    "filing_status": "single",
    "tax_year": 2026,
    "employee_hsa_cents": 0,
    "expected_usage": "medium",
    "selected_plan_index": 0,
}
# Spec 014 example 11.
W4: dict[str, Any] = {
    "salary_cents": OLD_SALARY,
    "pay_periods_per_year": 26,
    "filing_status": "single",
    "tax_year": 2026,
    "k401_contribution_pct": "5.00",
    "age": 24,
    "health_premium_per_paycheck_cents": 400,
    "current_withholding_per_paycheck_cents": 27_244,
}
FUND: dict[str, Any] = {
    "monthly_essentials_cents": 182_300,
    "target_months": 3,
    "current_balance_cents": 214_000,
    "monthly_contribution_cents": 30_000,
    "pay_periods_per_year": 26,
}
SAVED = {"k401_match": K401, "health_plans": HEALTH, "w4": W4}

SCHEDULE = {
    "kind": "changed",
    "input": "pay_periods_per_year",
    "text": "Your pay schedule changed from 26 to 24 paychecks a year.",
}
UNCONFIRMED = {
    "kind": "salary_unconfirmed",
    "input": "salary_cents",
    "text": (
        "Your newest pay stub comes to $64,999.92 a year, not the $95,000.10 in your plan"
        " details. Choose which salary to use."
    ),
}
SALARY = {
    "kind": "changed",
    "input": "salary_cents",
    "text": "Your yearly salary changed from $95,000.10 to $64,999.92.",
}


def saved_on_stub_01(
    client: TestClient, connection: Connection, user: FixtureUser
) -> dict[str, uuid.UUID]:
    """Rows 1-5's account before the new stub; the decision id of each calculator."""
    stub_01 = confirm_stub(client, connection, user, **STUB_01)
    saved = client.put("/profile", json={**PROFILE, "salary_pay_stub_id": str(stub_01)})
    assert saved.status_code == 200, saved.text
    return {
        calculator: save_decision(client, calculator, inputs)
        for calculator, inputs in SAVED.items()
    }


def reviews(client: TestClient) -> dict[str, list[dict[str, Any]]]:
    """Each calculator's current decision's ``review`` from ``GET /decisions``."""
    response = client.get("/decisions")
    assert response.status_code == 200, response.text
    return {item["calculator"]: item["current"]["review"] for item in response.json()["items"]}


def put_salary(client: TestClient, salary_cents: int) -> None:
    """Answer the salary question against the newest stub, as the step does."""
    question = client.get("/profile").json()["salary_review"]
    assert question is not None
    answered = client.put(
        "/profile",
        json={
            **PROFILE,
            "salary_cents": salary_cents,
            "salary_pay_stub_id": question["pay_stub_id"],
        },
    )
    assert answered.status_code == 200, answered.text
    assert answered.json()["salary_review"] is None


def test_every_decision_is_current_before_the_new_stub(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    saved_on_stub_01(client, db_connection, user_a)
    assert reviews(client) == {"k401_match": [], "health_plans": [], "w4": []}


def test_issue_222_a_newer_stub_on_another_schedule(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    ids = saved_on_stub_01(client, db_connection, user_a)
    confirm_stub(client, db_connection, user_a)
    expected = [SCHEDULE, UNCONFIRMED]
    assert reviews(client) == {"k401_match": expected, "health_plans": expected, "w4": expected}
    # One decision's own read says the same.
    one = client.get(f"/decisions/{ids['w4']}")
    assert one.status_code == 200, one.text
    assert one.json()["review"] == expected


def test_keeping_the_salary_leaves_the_schedule(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    saved_on_stub_01(client, db_connection, user_a)
    confirm_stub(client, db_connection, user_a)
    put_salary(client, OLD_SALARY)
    assert reviews(client) == {
        "k401_match": [SCHEDULE],
        "health_plans": [SCHEDULE],
        "w4": [SCHEDULE],
    }


def test_using_the_stubs_salary_changes_it_too(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    saved_on_stub_01(client, db_connection, user_a)
    confirm_stub(client, db_connection, user_a)
    put_salary(client, 6_499_992)
    expected = [SCHEDULE, SALARY]
    assert reviews(client) == {"k401_match": expected, "health_plans": expected, "w4": expected}


def test_saving_again_clears_it(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = saved_on_stub_01(client, db_connection, user_a)
    confirm_stub(client, db_connection, user_a)
    put_salary(client, 6_499_992)
    now = {"salary_cents": 6_499_992, "pay_periods_per_year": 24}
    for calculator, inputs in SAVED.items():
        save_decision(client, calculator, {**inputs, **now}, supersedes_id=first[calculator])
    assert reviews(client) == {"k401_match": [], "health_plans": [], "w4": []}
    # The versions they replaced are not current, so nothing about them needs review.
    old = client.get(f"/decisions/{first['health_plans']}").json()
    assert (old["is_current"], old["review"]) == (False, [])


def test_the_w4_follows_the_other_decisions(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    ids = saved_on_stub_01(client, db_connection, user_a)
    save_decision(
        client, "k401_match", {**K401, "contribution_pct": "6.00"}, supersedes_id=ids["k401_match"]
    )
    assert reviews(client) == {
        "k401_match": [],
        "health_plans": [],
        "w4": [
            {
                "kind": "changed",
                "input": "k401_contribution_pct",
                "text": "Your 401(k) decision changed from 5% to 6%.",
            }
        ],
    }


def test_a_new_tax_year(db_connection: Connection, client_as: Client, user_a: FixtureUser) -> None:
    """A stub-01 paycheck paid in 2027: the same pay, so no salary question."""
    client = client_as(user_a)
    saved_on_stub_01(client, db_connection, user_a)
    confirm_stub(
        client,
        db_connection,
        user_a,
        **{
            **STUB_01,
            "pay_date": "2027-01-08",
            "period_start": "2026-12-21",
            "period_end": "2027-01-03",
        },
    )
    year = {
        "kind": "changed",
        "input": "tax_year",
        "text": "The tax year changed from 2026 to 2027.",
    }
    age = {
        "kind": "changed",
        "input": "age",
        "text": "Your age at the end of the tax year changed from 24 to 25.",
    }
    assert reviews(client) == {"k401_match": [year, age], "health_plans": [year], "w4": [year, age]}


def test_plan_details_changes(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    saved_on_stub_01(client, db_connection, user_a)
    profile = client.get("/profile").json()
    changed = client.put(
        "/profile",
        json={
            **PROFILE,
            "filing_status": "married_filing_jointly",
            "match_tiers": [{"employee_pct_upto": "4", "employer_pct": "100"}],
            "salary_pay_stub_id": profile["salary_pay_stub_id"],
        },
    )
    assert changed.status_code == 200, changed.text
    filing = {
        "kind": "changed",
        "input": "filing_status",
        "text": "Your filing status changed from single to married filing jointly.",
    }
    match = {
        "kind": "changed",
        "input": "match_tiers",
        "text": (
            "Your employer match changed from 100% of the first 3%, then 50% up to 5%"
            " to 100% of the first 4%."
        ),
    }
    assert reviews(client) == {"k401_match": [filing, match], "health_plans": [filing], "w4": []}


def test_the_emergency_fund_reads_the_schedule_only(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    saved_on_stub_01(client, db_connection, user_a)
    save_decision(client, "emergency_fund", FUND)
    confirm_stub(client, db_connection, user_a)
    assert reviews(client)["emergency_fund"] == [SCHEDULE]
    put_salary(client, 6_499_992)
    assert reviews(client)["emergency_fund"] == [SCHEDULE]


def test_nothing_known_nothing_compared(client_as: Client, user_a: FixtureUser) -> None:
    """No stub and no profile: the step could not calculate, so nothing is compared."""
    client = client_as(user_a)
    save_decision(client, "k401_match", K401)
    assert reviews(client) == {"k401_match": []}
