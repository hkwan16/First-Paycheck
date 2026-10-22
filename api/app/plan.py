"""The user's plan in one read (spec 016 rules 1-8).

``build_plan`` is shared by ``GET /plan`` and the ``plan.export`` job, so the
screen and the PDF always show the same thing. It copies fields and does no
money arithmetic: every figure is a field a calculator produced, named by its
path (``inputs.x``, ``result.plans[0].y``). Every read runs in the caller's
RLS session.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import column, select, table
from sqlalchemy.orm import Session

from app.routers.calendar import CalendarEventOut
from app.routers.explain import CitationOut
from app.routers.goals import GoalOut, goal_out
from app.types import UtcDateTime
from calc.registry import calculator
from db.enums import CalculatorKind, CalendarStatus, PayFrequency
from db.models import CalendarEvent, Decision, Explanation, Goal, PayStub
from retrieval.citations import by_key, for_calculator

__all__ = [
    "CALENDAR_WINDOW",
    "PlanCompleteness",
    "PlanDecision",
    "PlanExplanation",
    "PlanFigure",
    "PlanOut",
    "PlanPayStub",
    "build_plan",
    "figures",
]

# Rule 6: the plan's calendar reaches 90 days past today.
CALENDAR_WINDOW = dt.timedelta(days=90)

_current_decisions = table("current_decisions", column("id"))

FigureKind = Literal["money", "percent", "count", "text"]
ExplanationStatus = Literal["verified", "fallback", "none"]


class PlanFigure(BaseModel):
    # Where the value comes from: ``inputs.<field>`` or ``result.<field>``.
    key: str
    label: str
    kind: FigureKind
    # Integer cents, a two-place percentage string, a count, a name, or null.
    value: int | str | None


class PlanExplanation(BaseModel):
    status: ExplanationStatus
    id: uuid.UUID | None
    concept: str | None
    text: str | None
    created_at: UtcDateTime | None
    citations: list[CitationOut]


class PlanDecision(BaseModel):
    id: uuid.UUID
    calculator: CalculatorKind
    version: int
    created_at: UtcDateTime
    inputs: dict[str, Any]
    result: dict[str, Any]
    figures: list[PlanFigure]
    explanation: PlanExplanation


class PlanCompleteness(BaseModel):
    saved: list[CalculatorKind]
    missing: list[CalculatorKind]


class PlanPayStub(BaseModel):
    id: uuid.UUID
    employer_name: str | None
    pay_frequency: PayFrequency | None
    pay_date: dt.date
    gross_cents: int
    federal_withholding_cents: int
    social_security_cents: int
    medicare_cents: int
    state_tax_cents: int
    retirement_contribution_cents: int
    medical_premium_cents: int
    other_deductions_cents: int
    net_cents: int


class PlanOut(BaseModel):
    as_of: dt.date
    calendar_through: dt.date
    completeness: PlanCompleteness
    decisions: list[PlanDecision]
    goals: list[GoalOut]
    calendar: list[CalendarEventOut]
    pay_stub: PlanPayStub | None


# ---------------------------------------------------------------- figures (rule 3)


def _value(data: dict[str, Any], key: str) -> Any:
    """The stored value at ``key``: ``inputs.a``, ``result.b`` or ``result.plans[2].c``."""
    value: Any = data
    for part in key.split("."):
        name, _, index = part.partition("[")
        value = value[name]
        if index:
            value = value[int(index.rstrip("]"))]
    return value


def _figure(data: dict[str, Any], key: str, label: str, kind: FigureKind) -> PlanFigure:
    return PlanFigure(key=key, label=label, kind=kind, value=_value(data, key))


def _emergency_fund(data: dict[str, Any]) -> list[PlanFigure]:
    return [
        _figure(data, "result.target_cents", "Target", "money"),
        _figure(data, "inputs.monthly_contribution_cents", "Monthly contribution", "money"),
        _figure(data, "result.per_paycheck_contribution_cents", "Per paycheck", "money"),
        _figure(data, "result.months_to_target", "Months to target", "count"),
        _figure(data, "result.funded_pct", "Funded today", "percent"),
    ]


def _k401(data: dict[str, Any]) -> list[PlanFigure]:
    return [
        _figure(data, "inputs.contribution_pct", "Your contribution", "percent"),
        _figure(data, "result.full_match_pct", "Contribution for the full match", "percent"),
        _figure(data, "result.employer_match_cents_current", "Employer match a year", "money"),
        _figure(data, "result.missed_cents", "Match missed a year", "money"),
    ]


def _health_plans(data: dict[str, Any]) -> list[PlanFigure]:
    # A saved health-plan decision always names its plan (spec 012 rule 14).
    plan = f"result.plans[{data['result']['selected_index']}]"
    usage = data["inputs"]["expected_usage"]
    return [
        _figure(data, f"{plan}.name", "Plan", "text"),
        _figure(
            data, f"{plan}.{usage}_cost_cents", f"Expected cost a year at {usage} use", "money"
        ),
        _figure(data, f"{plan}.annual_premium_cents", "Premiums a year", "money"),
        _figure(data, f"{plan}.worst_case_cents", "Worst case a year", "money"),
    ]


def _w4(data: dict[str, Any]) -> list[PlanFigure]:
    year = data["inputs"]["tax_year"]
    found = [
        _figure(
            data,
            "result.withholding_per_paycheck_cents",
            "Federal withholding per paycheck",
            "money",
        ),
        _figure(
            data,
            "result.projected_tax_after_credits_cents",
            f"Projected federal tax for {year}",
            "money",
        ),
        _figure(
            data, "result.projected_refund_cents", "Projected refund (negative is owed)", "money"
        ),
    ]
    suggestion = data["result"]["suggestion"]
    if suggestion in ("increase_extra_withholding", "decrease_extra_withholding"):
        found.append(
            _figure(
                data,
                "result.suggested_extra_withholding_cents",
                "Suggested Step 4(c) extra withholding per paycheck",
                "money",
            )
        )
    elif suggestion == "increase_deductions":
        found.append(
            _figure(
                data, "result.suggested_deductions_cents", "Suggested Step 4(b) deductions", "money"
            )
        )
    return found


_FIGURES = {
    CalculatorKind.EMERGENCY_FUND: _emergency_fund,
    CalculatorKind.K401_MATCH: _k401,
    CalculatorKind.HEALTH_PLANS: _health_plans,
    CalculatorKind.W4: _w4,
}


def figures(
    kind: CalculatorKind, inputs: dict[str, Any], result: dict[str, Any]
) -> list[PlanFigure]:
    """The plan's figures for one stored decision, copied from its inputs and result.

    The stored JSON is validated with the calculator's own models first, so a
    shape the calculator no longer produces fails loudly instead of showing a
    wrong field.
    """
    spec = calculator(kind)
    spec.input_model.model_validate(inputs)
    spec.result_model.model_validate(result)
    return _FIGURES[kind]({"inputs": inputs, "result": result})


# ---------------------------------------------------------------- reads


def _explanation(session: Session, decision: Decision) -> PlanExplanation:
    """Rule 4: the latest row by (created_at, attempt) decides the status."""
    row = session.scalars(
        select(Explanation)
        .where(Explanation.decision_id == decision.id)
        .order_by(Explanation.created_at.desc(), Explanation.attempt.desc())
        .limit(1)
    ).first()
    if row is None or not (row.verified or row.fallback):
        return PlanExplanation(
            status="none", id=None, concept=None, text=None, created_at=None, citations=[]
        )
    # The emergency fund has no tax year and no IRS passages (spec 011).
    year = decision.inputs.get("tax_year")
    known = for_calculator(session, decision.calculator, int(year)) if year is not None else []
    return PlanExplanation(
        status="verified" if row.verified else "fallback",
        id=row.id,
        concept=row.concept,
        text=row.text,
        created_at=row.created_at,
        citations=[
            CitationOut(
                key=citation.key,
                title=citation.title,
                url=citation.url,
                passage=citation.passage,
                source=citation.source,
            )
            for citation in by_key(known, row.citations)
        ],
    )


def _decision(session: Session, decision: Decision) -> PlanDecision:
    kind = CalculatorKind(decision.calculator)
    return PlanDecision(
        id=decision.id,
        calculator=kind,
        version=decision.version,
        created_at=decision.created_at,
        inputs=decision.inputs,
        result=decision.result,
        figures=figures(kind, decision.inputs, decision.result),
        explanation=_explanation(session, decision),
    )


def _decisions(session: Session) -> list[PlanDecision]:
    order = {kind: index for index, kind in enumerate(CalculatorKind)}
    rows = session.scalars(
        select(Decision).where(Decision.id.in_(select(_current_decisions.c.id)))
    ).all()
    rows = sorted(rows, key=lambda row: order[CalculatorKind(row.calculator)])
    return [_decision(session, row) for row in rows]


def _calendar(session: Session, start: dt.date, end: dt.date) -> list[CalendarEventOut]:
    rows = session.scalars(
        select(CalendarEvent)
        .where(
            CalendarEvent.status == CalendarStatus.UPCOMING,
            CalendarEvent.due_at >= start,
            CalendarEvent.due_at <= end,
        )
        .order_by(CalendarEvent.due_at, CalendarEvent.kind, CalendarEvent.id)
    )
    return [
        CalendarEventOut(
            id=row.id,
            kind=row.kind,
            title=row.title,
            due_at=row.due_at,
            decision_id=row.decision_id,
            status=row.status,
        )
        for row in rows
    ]


def _pay_stub(session: Session) -> PlanPayStub | None:
    stub = session.scalars(
        select(PayStub).order_by(PayStub.pay_date.desc(), PayStub.created_at.desc()).limit(1)
    ).first()
    if stub is None:
        return None
    return PlanPayStub(
        id=stub.id,
        employer_name=stub.employer_name,
        pay_frequency=stub.pay_frequency,
        pay_date=stub.pay_date,
        gross_cents=stub.gross_cents,
        federal_withholding_cents=stub.federal_withholding_cents,
        social_security_cents=stub.social_security_cents,
        medicare_cents=stub.medicare_cents,
        state_tax_cents=stub.state_tax_cents,
        retirement_contribution_cents=stub.retirement_contribution_cents,
        medical_premium_cents=stub.medical_premium_cents,
        other_deductions_cents=stub.other_deductions_cents,
        net_cents=stub.net_cents,
    )


def build_plan(session: Session, today: dt.date) -> PlanOut:
    """The plan as of ``today`` (UTC), read under the session's RLS."""
    through = today + CALENDAR_WINDOW
    decisions = _decisions(session)
    saved = [decision.calculator for decision in decisions]
    goals = session.scalars(select(Goal).order_by(Goal.created_at, Goal.id))
    return PlanOut(
        as_of=today,
        calendar_through=through,
        completeness=PlanCompleteness(
            saved=saved, missing=[kind for kind in CalculatorKind if kind not in saved]
        ),
        decisions=decisions,
        goals=[goal_out(session, goal) for goal in goals],
        calendar=_calendar(session, today, through),
        pay_stub=_pay_stub(session),
    )
