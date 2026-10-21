"""Saved decisions: recompute, version, and the calendar check they imply (spec 007).

``POST /decisions`` is the only code that inserts a decision. It never stores
what the client sent: it validates the inputs, reruns the calculator, refuses
any difference from the client's result and stores the server's own values.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy import column, exists, func, select, table, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import CurrentUser
from app.deps import Now, UserSession
from app.errors import AppError, NotFound, error_responses
from app.types import UtcDateTime
from calc.k401 import K401MatchInput
from calc.pay_dates import PERIODS, PayFrequency, frequency_for_periods, next_pay_date
from calc.registry import Calculator, UnknownCalculator, calculator
from db.enums import CalculatorKind, CalendarKind, CalendarStatus
from db.models import CalendarEvent, Decision, PayStub, Profile

router = APIRouter(prefix="/decisions", tags=["decisions"])

ELECTION_CHECK_TITLE = "Check that your next pay stub shows your new 401(k) contribution"
# The unique constraints a concurrent or repeated save runs into (rule 5).
_CONFLICT_CONSTRAINTS = frozenset(
    {"uq_decisions_user_id_calculator_version", "uq_decisions_supersedes_id"}
)
_CALCULATOR_ORDER = {kind: index for index, kind in enumerate(CalculatorKind)}
# The view of rows no other row supersedes (migration 0004), read under RLS.
_current_decisions = table("current_decisions", column("id"))


class DecisionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    calculator: CalculatorKind
    # The calculator's input model and the result the user saw, as /calc returned it.
    inputs: dict[str, Any]
    result: dict[str, Any]
    # The current decision for this calculator; null for the first.
    supersedes_id: uuid.UUID | None = None


class DecisionSaved(BaseModel):
    decision_id: uuid.UUID
    calculator: CalculatorKind
    version: int
    supersedes_id: uuid.UUID | None
    created_at: UtcDateTime
    calendar_event_id: uuid.UUID | None
    goal_id: uuid.UUID | None


class DecisionVersion(BaseModel):
    id: uuid.UUID
    version: int
    supersedes_id: uuid.UUID | None
    created_at: UtcDateTime


class DecisionOut(DecisionVersion):
    calculator: CalculatorKind
    check_in_id: uuid.UUID | None
    inputs: dict[str, Any]
    result: dict[str, Any]
    is_current: bool


class CalculatorDecisions(BaseModel):
    calculator: CalculatorKind
    current: DecisionOut
    # Every version, newest first.
    versions: list[DecisionVersion]


class DecisionList(BaseModel):
    items: list[CalculatorDecisions]


def _validation_message(prefix: str, exc: ValidationError) -> str:
    parts = []
    for error in exc.errors():
        location = ".".join(str(part) for part in (prefix, *error["loc"]))
        parts.append(f"{location}: {error['msg']}")
    return "; ".join(parts)


def _recompute(spec: Calculator, body: DecisionIn) -> tuple[BaseModel, BaseModel]:
    """Validate the inputs, rerun the calculator and compare (rule 2)."""
    try:
        inputs = spec.input_model.model_validate(body.inputs)
    except ValidationError as exc:
        raise AppError(
            _validation_message("inputs", exc), code="validation_error", status_code=422
        ) from exc
    computed = spec.run(inputs)
    try:
        sent = spec.result_model.model_validate(body.result)
    except ValidationError as exc:
        fields = sorted({str(error["loc"][0]) for error in exc.errors() if error["loc"]})
        raise AppError(
            "The result does not match the calculator's result",
            code="result_mismatch",
            status_code=422,
            details={"fields": fields},
        ) from exc
    differing = [
        name
        for name in spec.result_model.model_fields
        if getattr(sent, name) != getattr(computed, name)
    ]
    if differing:
        raise AppError(
            "The result does not match the calculator's result",
            code="result_mismatch",
            status_code=422,
            details={"fields": differing},
        )
    return inputs, computed


def _conflict() -> AppError:
    return AppError(
        "This decision has changed since you loaded it; reload and try again",
        code="decision_conflict",
        status_code=409,
    )


def _next_version(session: Session, body: DecisionIn) -> int:
    """Rule 4: the parent must be visible, of the same calculator and current."""
    if body.supersedes_id is None:
        return 1
    parent = session.get(Decision, body.supersedes_id)
    if parent is None:
        raise NotFound("Decision not found")
    if parent.calculator != body.calculator:
        raise AppError(
            "supersedes_id belongs to another calculator",
            code="supersedes_mismatch",
            status_code=422,
        )
    superseded = session.scalar(select(exists().where(Decision.supersedes_id == parent.id)))
    if superseded:
        raise _conflict()
    return parent.version + 1


def _pay_frequency(session: Session, user_id: uuid.UUID, periods: int) -> PayFrequency:
    """The profile's pay frequency, else the one the decision's pay periods imply."""
    profile = session.get(Profile, user_id)
    if profile is not None and profile.pay_frequency is not None:
        for frequency in PERIODS:
            if frequency == profile.pay_frequency:
                return frequency
    return frequency_for_periods(periods)


def _election_check(
    session: Session, decision: Decision, inputs: K401MatchInput, today: dt.date
) -> CalendarEvent:
    """Rule 14: one check per calculator, dated the next expected pay date."""
    anchor = session.scalar(select(func.max(PayStub.pay_date)))
    frequency = _pay_frequency(session, decision.user_id, inputs.pay_periods_per_year)
    if decision.supersedes_id is not None:
        session.execute(
            update(CalendarEvent)
            .where(
                CalendarEvent.decision_id == decision.supersedes_id,
                CalendarEvent.kind == CalendarKind.ELECTION_CHECK,
                CalendarEvent.status == CalendarStatus.UPCOMING,
            )
            .values(status=CalendarStatus.DISMISSED)
        )
    event = CalendarEvent(
        user_id=decision.user_id,
        kind=CalendarKind.ELECTION_CHECK,
        title=ELECTION_CHECK_TITLE,
        due_at=next_pay_date(frequency, anchor, today),
        decision_id=decision.id,
        status=CalendarStatus.UPCOMING,
    )
    session.add(event)
    session.flush()
    return event


@router.post("", status_code=status.HTTP_201_CREATED, responses=error_responses(401, 404, 409, 422))
def save_decision(
    body: DecisionIn, session: UserSession, user: CurrentUser, now: Now
) -> DecisionSaved:
    """Save the result the user picked as a new decision version."""
    try:
        spec = calculator(body.calculator)
    except UnknownCalculator as exc:
        raise AppError(
            f"Decisions for {body.calculator.value} are not available yet",
            code="calculator_unavailable",
            status_code=422,
        ) from exc
    inputs, computed = _recompute(spec, body)
    version = _next_version(session, body)
    decision = Decision(
        user_id=user.id,
        calculator=body.calculator,
        inputs=inputs.model_dump(mode="json"),
        result=computed.model_dump(mode="json"),
        version=version,
        supersedes_id=body.supersedes_id,
    )
    try:
        with session.begin_nested():
            session.add(decision)
    except IntegrityError as exc:
        constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if constraint in _CONFLICT_CONSTRAINTS:
            raise _conflict() from exc
        raise
    event = None
    if isinstance(inputs, K401MatchInput):
        event = _election_check(session, decision, inputs, now.date())
    return DecisionSaved(
        decision_id=decision.id,
        calculator=decision.calculator,
        version=decision.version,
        supersedes_id=decision.supersedes_id,
        created_at=decision.created_at,
        calendar_event_id=event.id if event is not None else None,
        goal_id=None,
    )


def _out(decision: Decision, *, is_current: bool) -> DecisionOut:
    return DecisionOut(
        id=decision.id,
        calculator=decision.calculator,
        version=decision.version,
        supersedes_id=decision.supersedes_id,
        check_in_id=decision.check_in_id,
        inputs=decision.inputs,
        result=decision.result,
        created_at=decision.created_at,
        is_current=is_current,
    )


@router.get("", responses=error_responses(401))
def list_decisions(session: UserSession) -> DecisionList:
    """The current decision and the version history of every calculator."""
    current = set(session.scalars(select(_current_decisions.c.id)))
    rows = session.scalars(select(Decision).order_by(Decision.version.desc()))
    by_calculator: dict[CalculatorKind, list[Decision]] = {}
    for row in rows:
        by_calculator.setdefault(row.calculator, []).append(row)
    items = []
    for kind in sorted(by_calculator, key=_CALCULATOR_ORDER.__getitem__):
        chain = by_calculator[kind]
        head = next(row for row in chain if row.id in current)
        items.append(
            CalculatorDecisions(
                calculator=kind,
                current=_out(head, is_current=True),
                versions=[
                    DecisionVersion(
                        id=row.id,
                        version=row.version,
                        supersedes_id=row.supersedes_id,
                        created_at=row.created_at,
                    )
                    for row in chain
                ],
            )
        )
    return DecisionList(items=items)


@router.get("/{decision_id}", responses=error_responses(401, 404))
def get_decision(decision_id: uuid.UUID, session: UserSession) -> DecisionOut:
    """One decision version; another user's id is 404."""
    decision = session.get(Decision, decision_id)
    if decision is None:
        raise NotFound("Decision not found")
    is_current = session.scalar(select(exists().where(_current_decisions.c.id == decision.id)))
    return _out(decision, is_current=bool(is_current))
