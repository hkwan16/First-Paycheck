"""What a saved decision changes besides the ``decisions`` row (spec 007 rules
14-16, spec 011 rules 9-14, spec 012 rules 14-15, spec 014 rule 18).

``POST /decisions`` calls ``check_saveable`` before it inserts anything and
``apply`` right after the insert, in the same transaction, so a failure here
saves nothing. Every read and write runs in the request's RLS session; dates
come from ``calc/pay_dates.py``. ``reproject_goal`` is the save's projection
of the emergency fund goal, which ``PATCH /goals/{id}`` reuses when the goal's
contribution changes (spec 011 rule 17a).
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Collection
from dataclasses import dataclass

from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.errors import AppError
from calc.emergency_fund import EmergencyFundInput, EmergencyFundResult, emergency_fund
from calc.health_plans import HealthPlansInput
from calc.k401 import K401MatchInput
from calc.pay_dates import PERIODS, PayFrequency, add_months, frequency_for_periods, next_pay_date
from calc.w4 import W4Input
from db.enums import (
    AccountRole,
    CalculatorKind,
    CalendarKind,
    CalendarStatus,
    GoalKind,
    GoalStatus,
)
from db.models import Account, CalendarEvent, Decision, Goal, PayStub, Profile

__all__ = [
    "ELECTION_CHECK_TITLE",
    "ENROLLMENT_DEADLINE_TITLE",
    "GOAL_CONTRIBUTION_TITLE",
    "GOAL_REVIEW_TITLE",
    "REVIEW_AFTER_MONTHS",
    "W4_SUBMIT_TITLE",
    "Effects",
    "apply",
    "check_saveable",
    "reproject_goal",
]

ELECTION_CHECK_TITLE = "Check that your next pay stub shows your new 401(k) contribution"
GOAL_CONTRIBUTION_TITLE = "Make your first emergency fund contribution"
GOAL_REVIEW_TITLE = "Review your emergency fund progress"
ENROLLMENT_DEADLINE_TITLE = "Health plan enrollment deadline"
W4_SUBMIT_TITLE = "Give your employer your updated Form W-4"
# Spec 011 rule 12: the review is three months after the first contribution.
REVIEW_AFTER_MONTHS = 3


@dataclass(frozen=True)
class Effects:
    calendar_event_id: uuid.UUID | None = None
    goal_id: uuid.UUID | None = None


def check_saveable(inputs: BaseModel) -> None:
    """Refuse a decision that cannot be saved even though its inputs are valid."""
    if isinstance(inputs, HealthPlansInput) and inputs.selected_plan_index is None:
        raise AppError(
            "Pick a plan before saving: selected_plan_index is required",
            code="plan_not_selected",
            status_code=422,
        )


def apply(
    session: Session, decision: Decision, inputs: BaseModel, result: BaseModel, today: dt.date
) -> Effects:
    if isinstance(inputs, K401MatchInput):
        return _k401(session, decision, inputs, today)
    if isinstance(inputs, EmergencyFundInput) and isinstance(result, EmergencyFundResult):
        return _emergency_fund(session, decision, inputs, result, today)
    if isinstance(inputs, HealthPlansInput):
        return _health_plans(session, decision, inputs, today)
    if isinstance(inputs, W4Input):
        return _w4(session, decision, inputs, today)
    return Effects()


def _pay_frequency(session: Session, user_id: uuid.UUID, periods: int) -> PayFrequency:
    """The profile's pay frequency, else the one the decision's pay periods imply."""
    profile = session.get(Profile, user_id)
    if profile is not None and profile.pay_frequency is not None:
        for frequency in PERIODS:
            if frequency == profile.pay_frequency:
                return frequency
    return frequency_for_periods(periods)


def _next_pay_date(session: Session, user_id: uuid.UUID, periods: int, today: dt.date) -> dt.date:
    """Spec 007 rule 16, anchored on the latest confirmed pay stub."""
    anchor = session.scalar(select(func.max(PayStub.pay_date)))
    return next_pay_date(_pay_frequency(session, user_id, periods), anchor, today)


def _target_date(first: dt.date, result: EmergencyFundResult) -> dt.date | None:
    """Spec 011 rule 11: the last contribution's date; None when funded or out of reach."""
    months = result.months_to_target
    return add_months(first, months - 1) if months else None


def reproject_goal(session: Session, goal: Goal, today: dt.date) -> dt.date | None:
    """Spec 011 rule 17a: the goal's date at its own contribution, as a save projects it.

    The goal's decision supplies every other input; the calculator and the
    first contribution date are the ones a save uses (rule 11). A goal without
    an emergency-fund decision has no projection.
    """
    decision = session.get(Decision, goal.decision_id) if goal.decision_id else None
    if decision is None or decision.calculator != CalculatorKind.EMERGENCY_FUND:
        return None
    inputs = EmergencyFundInput.model_validate(
        {**decision.inputs, "monthly_contribution_cents": goal.monthly_contribution_cents}
    )
    first = _next_pay_date(session, decision.user_id, inputs.pay_periods_per_year, today)
    return _target_date(first, emergency_fund(inputs))


def _dismiss_superseded(
    session: Session, decision: Decision, kinds: Collection[CalendarKind]
) -> None:
    """The previous version's upcoming events of ``kinds`` give way to the new ones."""
    if decision.supersedes_id is None:
        return
    session.execute(
        update(CalendarEvent)
        .where(
            CalendarEvent.decision_id == decision.supersedes_id,
            CalendarEvent.kind.in_(list(kinds)),
            CalendarEvent.status == CalendarStatus.UPCOMING,
        )
        .values(status=CalendarStatus.DISMISSED)
    )


def _event(
    session: Session, decision: Decision, kind: CalendarKind, title: str, due_at: dt.date
) -> CalendarEvent:
    event = CalendarEvent(
        user_id=decision.user_id,
        kind=kind,
        title=title,
        due_at=due_at,
        decision_id=decision.id,
        status=CalendarStatus.UPCOMING,
    )
    session.add(event)
    session.flush()
    return event


def _k401(session: Session, decision: Decision, inputs: K401MatchInput, today: dt.date) -> Effects:
    """Spec 007 rule 14: one check per calculator, dated the next expected pay date."""
    _dismiss_superseded(session, decision, [CalendarKind.ELECTION_CHECK])
    due = _next_pay_date(session, decision.user_id, inputs.pay_periods_per_year, today)
    event = _event(session, decision, CalendarKind.ELECTION_CHECK, ELECTION_CHECK_TITLE, due)
    return Effects(calendar_event_id=event.id)


def _emergency_fund_account(session: Session) -> uuid.UUID | None:
    """Spec 011 rule 10: the oldest active account the user marked as their fund."""
    return session.scalar(
        select(Account.id)
        .where(Account.role == AccountRole.EMERGENCY_FUND, Account.is_active)
        .order_by(Account.created_at, Account.id)
        .limit(1)
    )


def _emergency_fund(
    session: Session,
    decision: Decision,
    inputs: EmergencyFundInput,
    result: EmergencyFundResult,
    today: dt.date,
) -> Effects:
    """Spec 011 rules 9-14: create or update the goal, then the two checkpoints."""
    first = _next_pay_date(session, decision.user_id, inputs.pay_periods_per_year, today)

    goal = session.scalars(
        select(Goal).where(Goal.kind == GoalKind.EMERGENCY_FUND).with_for_update()
    ).one_or_none()
    account_id = goal.account_id if goal is not None else None
    if account_id is None:
        account_id = _emergency_fund_account(session)
    if goal is None:
        goal = Goal(user_id=decision.user_id, kind=GoalKind.EMERGENCY_FUND)
        session.add(goal)
    goal.account_id = account_id
    goal.target_amount_cents = result.target_cents
    goal.monthly_contribution_cents = inputs.monthly_contribution_cents
    goal.decision_id = decision.id
    goal.target_date = _target_date(first, result)
    goal.status = GoalStatus.ACTIVE
    goal.reached_at = None
    session.flush()

    _dismiss_superseded(
        session, decision, [CalendarKind.GOAL_CONTRIBUTION, CalendarKind.GOAL_REVIEW]
    )
    if inputs.monthly_contribution_cents > 0 and not result.funded:
        _event(session, decision, CalendarKind.GOAL_CONTRIBUTION, GOAL_CONTRIBUTION_TITLE, first)
    review = _event(
        session,
        decision,
        CalendarKind.GOAL_REVIEW,
        GOAL_REVIEW_TITLE,
        add_months(first, REVIEW_AFTER_MONTHS),
    )
    return Effects(calendar_event_id=review.id, goal_id=goal.id)


def _health_plans(
    session: Session, decision: Decision, inputs: HealthPlansInput, today: dt.date
) -> Effects:
    """Spec 012 rule 15: the enrollment deadline, when one is given and still ahead."""
    _dismiss_superseded(session, decision, [CalendarKind.ENROLLMENT_DEADLINE])
    deadline = inputs.enrollment_deadline
    if deadline is None or deadline < today:
        return Effects()
    event = _event(
        session, decision, CalendarKind.ENROLLMENT_DEADLINE, ENROLLMENT_DEADLINE_TITLE, deadline
    )
    return Effects(calendar_event_id=event.id)


def _w4(session: Session, decision: Decision, inputs: W4Input, today: dt.date) -> Effects:
    """Spec 014 rule 18: hand the employer the new form before the next paycheck."""
    _dismiss_superseded(session, decision, [CalendarKind.W4_SUBMIT])
    due = _next_pay_date(session, decision.user_id, inputs.pay_periods_per_year, today)
    event = _event(session, decision, CalendarKind.W4_SUBMIT, W4_SUBMIT_TITLE, due)
    return Effects(calendar_event_id=event.id)
