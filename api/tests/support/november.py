"""Spec 015's November user in Postgres: the check-in job and route tests share it.

Stubs S1 (paid 2026-10-31) and S2 (paid 2026-11-15), a 4% 401(k) election and
the "HDHP + HSA" plan saved on 2026-10-20, an emergency-fund goal started on
2026-08-01 that is 16,000 behind on 2026-11-15, and the new Equinox charge.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection

from db.enums import AccountKind, AccountRole, CalculatorKind, RecurringStatus
from tests.conftest import FixtureUser
from tests.support.factories import (
    MOCKUP_STUB,
    make_account,
    make_decision,
    make_document,
    make_goal,
    make_item,
    make_pay_stub,
    make_recurring_charge,
    make_snapshot,
)

# The clock the jobs run on: the day after S2 was paid.
NOW = dt.datetime(2026, 11, 16, 12, 0, tzinfo=dt.UTC)
PERIOD = dt.date(2026, 11, 1)
DECIDED_AT = dt.datetime(2026, 10, 20, 17, 0, tzinfo=dt.UTC)

S1: dict[str, Any] = {
    **MOCKUP_STUB,
    "pay_date": dt.date(2026, 10, 31),
    "period_start": dt.date(2026, 10, 16),
    "period_end": dt.date(2026, 10, 31),
}
S2: dict[str, Any] = {
    **MOCKUP_STUB,
    "pay_date": dt.date(2026, 11, 15),
    "period_start": dt.date(2026, 11, 1),
    "period_end": dt.date(2026, 11, 15),
    "federal_withholding_cents": 21_196,
    "retirement_contribution_cents": 5_417,
    "medical_premium_cents": 3_125,
    "net_cents": 205_892,
}

K401_INPUTS: dict[str, Any] = {
    "salary_cents": 6_500_000,
    "pay_periods_per_year": 24,
    "match_tiers": [{"employee_pct_upto": "4.00", "employer_pct": "100.00"}],
    "contribution_pct": "4.00",
    "tax_year": 2026,
    "filing_status": "single",
    "age": 23,
}
HEALTH_INPUTS: dict[str, Any] = {
    "plans": [
        {
            "name": "Gold PPO",
            "kind": "ppo",
            "premium_per_period_cents": 6_250,
            "deductible_cents": 50_000,
            "coinsurance_pct": "10.00",
            "oop_max_cents": 300_000,
            "employer_hsa_cents": 0,
        },
        {
            "name": "HDHP + HSA",
            "kind": "hdhp",
            "premium_per_period_cents": 3_125,
            "deductible_cents": 170_000,
            "coinsurance_pct": "20.00",
            "oop_max_cents": 500_000,
            "employer_hsa_cents": 60_000,
        },
    ],
    "pay_periods_per_year": 24,
    "salary_cents": 6_500_000,
    "filing_status": "single",
    "tax_year": 2026,
    "employee_hsa_cents": 0,
    "expected_usage": "low",
    "selected_plan_index": 1,
}
EMERGENCY_FUND_INPUTS: dict[str, Any] = {
    "monthly_essentials_cents": 182_300,
    "target_months": 3,
    "current_balance_cents": 200_000,
    "monthly_contribution_cents": 30_000,
    "pay_periods_per_year": 24,
}


@dataclass(frozen=True)
class November:
    stubs: tuple[uuid.UUID, uuid.UUID]
    k401: uuid.UUID
    health: uuid.UUID
    emergency_fund: uuid.UUID
    goal: uuid.UUID
    savings: uuid.UUID
    equinox: uuid.UUID


def november(connection: Connection, user: FixtureUser) -> November:
    stubs = tuple(
        make_pay_stub(
            connection, user.id, make_document(connection, user.id, with_blob=False), **fields
        )
        for fields in (S1, S2)
    )
    k401 = make_decision(
        connection, user.id, CalculatorKind.K401_MATCH, K401_INPUTS, created_at=DECIDED_AT
    )
    health = make_decision(
        connection, user.id, CalculatorKind.HEALTH_PLANS, HEALTH_INPUTS, created_at=DECIDED_AT
    )
    emergency_fund = make_decision(
        connection,
        user.id,
        CalculatorKind.EMERGENCY_FUND,
        EMERGENCY_FUND_INPUTS,
        created_at=dt.datetime(2026, 8, 1, 9, 0, tzinfo=dt.UTC),
    )
    item = make_item(connection, user.id)
    savings = make_account(
        connection,
        user.id,
        item,
        kind=AccountKind.SAVINGS,
        name="Chase Savings",
        mask="7730",
        role=AccountRole.EMERGENCY_FUND,
    )
    for as_of, cents in (
        (dt.datetime(2026, 7, 31, 6, tzinfo=dt.UTC), 200_000),
        (dt.datetime(2026, 11, 15, 6, tzinfo=dt.UTC), 274_000),
    ):
        make_snapshot(connection, user.id, savings, balance_cents=cents, as_of=as_of)
    goal = make_goal(connection, user.id, account_id=savings, decision_id=emergency_fund)
    equinox = make_recurring_charge(
        connection,
        user.id,
        merchant_norm="equinox",
        merchant_clean="Equinox",
        typical_amount_cents=18_500,
        first_seen=dt.date(2026, 9, 3),
        last_seen=dt.date(2026, 11, 3),
        status=RecurringStatus.NEW,
    )
    return November(
        stubs=(stubs[0], stubs[1]),
        k401=k401,
        health=health,
        emergency_fund=emergency_fund,
        goal=goal,
        savings=savings,
        equinox=equinox,
    )
