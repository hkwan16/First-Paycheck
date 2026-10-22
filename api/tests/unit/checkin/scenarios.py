"""Spec 015's November user, shared by the finder tests and the engine tests."""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal
from typing import Any

from checkin.findings import (
    BalanceFact,
    EventFact,
    Facts,
    GoalFact,
    HealthFact,
    K401Fact,
    RecurringFact,
    StubFact,
)
from db.enums import CalendarKind, GoalKind, RecurringCadence, RecurringStatus

PERIOD = dt.date(2026, 11, 1)
TODAY = dt.date(2026, 11, 16)
DECIDED = dt.date(2026, 10, 20)

K401_DECISION = uuid.UUID(int=0x401)
HEALTH_DECISION = uuid.UUID(int=0x4EA1)
GOAL_DECISION = uuid.UUID(int=0xEF)
GOAL = uuid.UUID(int=0x60A1)

S1: dict[str, Any] = {
    "id": uuid.UUID(int=0x51),
    "pay_date": dt.date(2026, 10, 31),
    "period_start": dt.date(2026, 10, 16),
    "period_end": dt.date(2026, 10, 31),
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
S2: dict[str, Any] = {
    **S1,
    "id": uuid.UUID(int=0x52),
    "pay_date": dt.date(2026, 11, 15),
    "period_start": dt.date(2026, 11, 1),
    "period_end": dt.date(2026, 11, 15),
    "federal_withholding_cents": 21_196,
    "retirement_contribution_cents": 5_417,
    "medical_premium_cents": 3_125,
    "net_cents": 205_892,
}
S3: dict[str, Any] = {
    **S1,
    "id": uuid.UUID(int=0x53),
    "gross_cents": 291_667,
    "social_security_cents": 18_083,
    "medicare_cents": 4_229,
    "net_cents": 218_845,
}


def stub(base: dict[str, Any], **changes: Any) -> StubFact:
    return StubFact(**{**base, **changes})


K401 = K401Fact(decision_id=K401_DECISION, decided_on=DECIDED, contribution_pct=Decimal("4"))
HEALTH = HealthFact(
    decision_id=HEALTH_DECISION,
    decided_on=DECIDED,
    plan_name="HDHP + HSA",
    premium_per_period_cents=3_125,
)


def goal(**changes: Any) -> GoalFact:
    fields: dict[str, Any] = {
        "id": GOAL,
        "kind": GoalKind.EMERGENCY_FUND,
        "decision_id": GOAL_DECISION,
        "started_on": dt.date(2026, 8, 1),
        "target_amount_cents": 547_000,
        "monthly_contribution_cents": 30_000,
        "balances": [
            BalanceFact(as_of=dt.date(2026, 7, 31), balance_cents=200_000),
            BalanceFact(as_of=dt.date(2026, 11, 15), balance_cents=274_000),
        ],
        **changes,
    }
    return GoalFact(**fields)


def charge(merchant: str, status: RecurringStatus, typical: int, **changes: Any) -> RecurringFact:
    fields: dict[str, Any] = {
        "id": uuid.uuid5(uuid.NAMESPACE_URL, merchant),
        "merchant": merchant,
        "cadence": RecurringCadence.MONTHLY,
        "status": status,
        "user_status": None,
        "typical_amount_cents": typical,
        "first_seen": dt.date(2026, 9, 3),
        "last_seen": dt.date(2026, 11, 3),
        "last_reported_amount_cents": None,
        **changes,
    }
    return RecurringFact(**fields)


def event(kind: CalendarKind, due: str, title: str = "Checkpoint") -> EventFact:
    return EventFact(
        id=uuid.uuid5(uuid.NAMESPACE_URL, f"{kind}:{due}"),
        kind=kind,
        title=title,
        due_at=dt.date.fromisoformat(due),
        decision_id=None,
    )


def facts(**fields: Any) -> Facts:
    return Facts(period=PERIOD, today=TODAY, **fields)
