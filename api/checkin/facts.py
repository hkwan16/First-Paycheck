"""What the finders read, loaded from the user's rows under RLS (spec 015, Inputs).

Every function takes the caller's user session: the job's
``user_session_for(user_id)`` or a route's ``UserSession``. Nothing here
writes or adds money; it maps rows to the plain facts the finders take.
"""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import column, select, table, text
from sqlalchemy.orm import Session

from calc.cashflow import PlanTargets
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
from db.enums import (
    CalculatorKind,
    CalendarStatus,
    FindingKind,
    GoalKind,
    GoalStatus,
    RecurringStatus,
)
from db.models import (
    BalanceSnapshot,
    CalendarEvent,
    Decision,
    Goal,
    PayStub,
    RecurringCharge,
)

__all__ = ["DEADLINE_WINDOW_DAYS", "current_decisions", "load_facts", "plan_targets", "utc_date"]

# Rule 7: events due within this many days of today are upcoming deadlines.
DEADLINE_WINDOW_DAYS = 30

_CURRENT = table("current_decisions", column("id"))
_FLAGGED = (RecurringStatus.NEW, RecurringStatus.CHANGED, RecurringStatus.STOPPED)
_RECURRING_KINDS = (
    FindingKind.RECURRING_NEW,
    FindingKind.RECURRING_CHANGED,
    FindingKind.RECURRING_STOPPED,
)


def utc_date(moment: dt.datetime) -> dt.date:
    return moment.astimezone(dt.UTC).date()


def current_decisions(session: Session) -> dict[CalculatorKind, Decision]:
    """The current decision of each calculator (spec 001 rule 18)."""
    rows = session.scalars(select(Decision).where(Decision.id.in_(select(_CURRENT.c.id))))
    return {row.calculator: row for row in rows}


def _k401(decision: Decision | None) -> K401Fact | None:
    if decision is None:
        return None
    return K401Fact(
        decision_id=decision.id,
        decided_on=utc_date(decision.created_at),
        contribution_pct=Decimal(str(decision.inputs["contribution_pct"])),
    )


def _selected_plan(decision: Decision) -> dict[str, Any] | None:
    index = decision.inputs.get("selected_plan_index")
    plans = decision.inputs.get("plans") or []
    if not isinstance(index, int) or not 0 <= index < len(plans):
        return None
    plan: dict[str, Any] = plans[index]
    return plan


def _health(decision: Decision | None) -> HealthFact | None:
    plan = _selected_plan(decision) if decision is not None else None
    if decision is None or plan is None:
        return None
    return HealthFact(
        decision_id=decision.id,
        decided_on=utc_date(decision.created_at),
        plan_name=str(plan["name"]),
        premium_per_period_cents=int(plan["premium_per_period_cents"]),
    )


def _stub(row: PayStub) -> StubFact:
    return StubFact(
        id=row.id,
        pay_date=row.pay_date,
        period_start=row.period_start,
        period_end=row.period_end,
        gross_cents=row.gross_cents,
        federal_withholding_cents=row.federal_withholding_cents,
        social_security_cents=row.social_security_cents,
        medicare_cents=row.medicare_cents,
        state_tax_cents=row.state_tax_cents,
        retirement_contribution_cents=row.retirement_contribution_cents,
        medical_premium_cents=row.medical_premium_cents,
        other_deductions_cents=row.other_deductions_cents,
        net_cents=row.net_cents,
    )


def _goals(session: Session, decisions: dict[uuid.UUID, Decision]) -> list[GoalFact]:
    goals = session.scalars(
        select(Goal)
        .where(Goal.status == GoalStatus.ACTIVE, Goal.account_id.is_not(None))
        .order_by(Goal.created_at, Goal.id)
    )
    facts: list[GoalFact] = []
    for goal in goals:
        balances = session.execute(
            select(BalanceSnapshot.as_of, BalanceSnapshot.balance_cents)
            .where(BalanceSnapshot.account_id == goal.account_id)
            .order_by(BalanceSnapshot.as_of)
        ).all()
        decision = decisions.get(goal.decision_id) if goal.decision_id else None
        started = decision.created_at if decision is not None else goal.created_at
        facts.append(
            GoalFact(
                id=goal.id,
                kind=goal.kind,
                decision_id=goal.decision_id,
                started_on=utc_date(started),
                target_amount_cents=goal.target_amount_cents,
                monthly_contribution_cents=goal.monthly_contribution_cents,
                balances=[
                    BalanceFact(as_of=utc_date(as_of), balance_cents=cents)
                    for as_of, cents in balances
                ],
            )
        )
    return facts


_LAST_REPORTED = text(
    """
    SELECT DISTINCT ON (payload->>'recurring_charge_id')
      payload->>'recurring_charge_id' AS charge_id,
      (payload->>'typical_amount_cents')::bigint AS amount
    FROM check_in_findings
    WHERE kind::text = ANY(:kinds) AND payload->>'recurring_charge_id' = ANY(:ids)
    ORDER BY payload->>'recurring_charge_id', created_at DESC, id DESC
    """
)


def _recurring(session: Session) -> list[RecurringFact]:
    charges = list(
        session.scalars(
            select(RecurringCharge)
            .where(RecurringCharge.status.in_(_FLAGGED))
            .order_by(RecurringCharge.merchant_clean, RecurringCharge.cadence, RecurringCharge.id)
        )
    )
    reported: dict[str, int] = {
        row.charge_id: int(row.amount)
        for row in session.execute(
            _LAST_REPORTED,
            {
                "kinds": [kind.value for kind in _RECURRING_KINDS],
                "ids": [str(c.id) for c in charges],
            },
        )
    }
    return [
        RecurringFact(
            id=charge.id,
            merchant=charge.merchant_clean,
            cadence=charge.cadence,
            status=charge.status,
            user_status=charge.user_status,
            typical_amount_cents=charge.typical_amount_cents,
            first_seen=charge.first_seen,
            last_seen=charge.last_seen,
            last_reported_amount_cents=reported.get(str(charge.id)),
        )
        for charge in charges
    ]


def _events(session: Session, today: dt.date) -> list[EventFact]:
    rows = session.scalars(
        select(CalendarEvent)
        .where(
            CalendarEvent.status == CalendarStatus.UPCOMING,
            CalendarEvent.due_at.between(today, today + dt.timedelta(days=DEADLINE_WINDOW_DAYS)),
        )
        .order_by(CalendarEvent.due_at, CalendarEvent.created_at, CalendarEvent.id)
    )
    return [
        EventFact(
            id=row.id,
            kind=row.kind,
            title=row.title,
            due_at=row.due_at,
            decision_id=row.decision_id,
        )
        for row in rows
    ]


def load_facts(session: Session, period: dt.date, today: dt.date) -> Facts:
    """Everything the finders read for ``period``, as of ``today``."""
    current = current_decisions(session)
    stubs = session.scalars(
        select(PayStub)
        .order_by(PayStub.pay_date.desc(), PayStub.created_at.desc(), PayStub.id.desc())
        .limit(2)
    )
    by_id = {decision.id: decision for decision in current.values()}
    goal_decisions = {
        row.id: row
        for row in session.scalars(
            select(Decision).where(Decision.id.in_(select(Goal.decision_id)))
        )
    }
    w4 = current.get(CalculatorKind.W4)
    return Facts(
        period=period,
        today=today,
        pay_stubs=[_stub(row) for row in stubs],
        k401=_k401(current.get(CalculatorKind.K401_MATCH)),
        health=_health(current.get(CalculatorKind.HEALTH_PLANS)),
        w4_decision_id=w4.id if w4 is not None else None,
        goals=_goals(session, {**goal_decisions, **by_id}),
        recurring=_recurring(session),
        events=_events(session, today),
    )


def plan_targets(session: Session) -> PlanTargets:
    """What the current decisions planned for a month (spec 015 rule 19)."""
    current = current_decisions(session)
    k401 = current.get(CalculatorKind.K401_MATCH)
    health = current.get(CalculatorKind.HEALTH_PLANS)
    emergency_fund = current.get(CalculatorKind.EMERGENCY_FUND)
    plan = _selected_plan(health) if health is not None else None
    goal = session.scalars(
        select(Goal).where(Goal.kind == GoalKind.EMERGENCY_FUND, Goal.status == GoalStatus.ACTIVE)
    ).one_or_none()
    return PlanTargets(
        contribution_pct=(
            Decimal(str(k401.inputs["contribution_pct"])) if k401 is not None else None
        ),
        premium_per_period_cents=(
            int(plan["premium_per_period_cents"]) if plan is not None else None
        ),
        monthly_essentials_cents=(
            int(emergency_fund.inputs["monthly_essentials_cents"])
            if emergency_fund is not None
            else None
        ),
        monthly_savings_cents=goal.monthly_contribution_cents if goal is not None else None,
    )
