"""Monthly check-ins: the list, one check-in with its findings and the month's cash
flow against the plan, the user's action on a finding, and checking in now
(spec 015 rules 13, 17-19 and 23).

The ``checkin.monthly`` job writes check-ins and findings; these routes read
them, queue that job on request, and record only what belongs to the user:
``done``, ``dismissed`` or an undo. Every query runs in the request's RLS session.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import ratelimit
from app.auth import CurrentUser
from app.deps import Now, UserSession
from app.errors import NotFound, error_responses
from app.routers.cashflow import CashFlow, cash_flow_for
from app.types import UtcDateTime
from calc.cashflow import PlanLine, SpendingActuals, against_plan
from checkin.engine import month_end, queue_check_in_now, settle_status
from checkin.facts import plan_targets
from checkin.findings import FindingPayload
from db.enums import (
    CheckinStatus,
    CheckinTrigger,
    FindingAction,
    FindingKind,
    FindingSeverity,
)
from db.models import CheckIn, CheckInFinding

router = APIRouter(prefix="/check-ins", tags=["check-ins"])

_SEVERITY_ORDER = {
    FindingSeverity.ALERT: 0,
    FindingSeverity.WARNING: 1,
    FindingSeverity.INFO: 2,
}
_KIND_ORDER = {kind: index for index, kind in enumerate(FindingKind)}


class CheckInSummary(BaseModel):
    id: uuid.UUID
    # First day of the reviewed month.
    period: dt.date
    triggered_by: CheckinTrigger
    status: CheckinStatus
    completed_at: UtcDateTime | None
    finding_count: int
    # Findings the user marked done or dismissed.
    handled_count: int
    created_at: UtcDateTime
    updated_at: UtcDateTime


class FindingOut(BaseModel):
    id: uuid.UUID
    check_in_id: uuid.UUID
    kind: FindingKind
    severity: FindingSeverity
    # What the finding reports; stable across refreshes of the check-in.
    key: str
    # The decision the finding affects, when there is one.
    decision_id: uuid.UUID | None
    payload: FindingPayload
    user_action: FindingAction | None
    user_action_at: UtcDateTime | None
    created_at: UtcDateTime
    updated_at: UtcDateTime


class CheckInCashFlow(BaseModel):
    # Exactly GET /cashflow for the check-in's month, up to today.
    cash_flow: CashFlow
    # Each line's actual beside the saved decisions' monthly target.
    plan: list[PlanLine]


class CheckInDetail(CheckInSummary):
    # By severity (alert first), then kind, then age.
    findings: list[FindingOut]
    cash_flow: CheckInCashFlow


class CheckInQueued(BaseModel):
    # The checkin.monthly job that creates or refreshes this month's check-in;
    # its result carries check_in_id once it has run.
    job_id: uuid.UUID
    # This month's check-in when it already exists, else null.
    check_in_id: uuid.UUID | None


class FindingPatch(BaseModel):
    """``done`` or ``dismissed``, or null to undo."""

    model_config = ConfigDict(extra="forbid")

    user_action: Annotated[FindingAction | None, Field(description="null undoes the action")]


def _summary(check_in: CheckIn, total: int, handled: int) -> CheckInSummary:
    return CheckInSummary(
        id=check_in.id,
        period=check_in.period,
        triggered_by=check_in.triggered_by,
        status=check_in.status,
        completed_at=check_in.completed_at,
        finding_count=total,
        handled_count=handled,
        created_at=check_in.created_at,
        updated_at=check_in.updated_at,
    )


def _finding_out(row: CheckInFinding) -> FindingOut:
    return FindingOut.model_validate(
        {
            "id": row.id,
            "check_in_id": row.check_in_id,
            "kind": row.kind,
            "severity": row.severity,
            "key": row.key,
            "decision_id": row.decision_id,
            "payload": row.payload,
            "user_action": row.user_action,
            "user_action_at": row.user_action_at,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
    )


@router.get("", responses=error_responses(401))
def list_check_ins(session: UserSession) -> list[CheckInSummary]:
    """The user's check-ins, newest month first, with finding counts."""
    rows = session.execute(
        select(
            CheckIn,
            func.count(CheckInFinding.id),
            func.count(CheckInFinding.user_action),
        )
        .outerjoin(
            CheckInFinding,
            (CheckInFinding.check_in_id == CheckIn.id)
            & (CheckInFinding.user_id == CheckIn.user_id),
        )
        .group_by(CheckIn.id)
        .order_by(CheckIn.period.desc(), CheckIn.created_at.desc(), CheckIn.id)
    ).all()
    return [_summary(check_in, total, handled) for check_in, total, handled in rows]


@router.post("", status_code=status.HTTP_202_ACCEPTED, responses=error_responses(401, 429))
def check_in_now(session: UserSession, user: CurrentUser, now: Now) -> CheckInQueued:
    """Create or refresh this month's check-in: queue its job, or return the waiting one."""
    ratelimit.consume(session, user.id, ratelimit.CHECK_INS, now=now)
    period = now.astimezone(dt.UTC).date().replace(day=1)
    job_id = queue_check_in_now(session, user.id, period)
    check_in_id = session.scalar(
        select(CheckIn.id).where(
            CheckIn.period == period, CheckIn.triggered_by == CheckinTrigger.SCHEDULE
        )
    )
    return CheckInQueued(job_id=job_id, check_in_id=check_in_id)


def _cash_flow(session: Session, check_in: CheckIn, today: dt.date) -> CheckInCashFlow:
    """Rule 19: the month to date (or the whole month once it is over) against the plan."""
    end = max(check_in.period, min(month_end(check_in.period), today))
    flow = cash_flow_for(session, check_in.period, end)
    spending = flow.spending
    actuals = SpendingActuals(
        take_home_cents=spending.income_cents,
        essentials_cents=spending.essentials_cents,
        flexible_cents=spending.flexible_cents,
        other_cents=spending.other_cents,
        savings_cents=spending.savings_cents,
        left_over_cents=spending.left_over_cents,
    )
    return CheckInCashFlow(
        cash_flow=flow,
        plan=against_plan(
            flow.withholding, flow.withholding.paycheck_count, actuals, plan_targets(session)
        ),
    )


@router.get("/{check_in_id}", responses=error_responses(401, 404, 422))
def get_check_in(check_in_id: uuid.UUID, session: UserSession, now: Now) -> CheckInDetail:
    """One check-in: its findings and the month's cash flow against the plan."""
    check_in = session.get(CheckIn, check_in_id)
    if check_in is None:
        raise NotFound("Check-in not found")
    rows = list(
        session.scalars(select(CheckInFinding).where(CheckInFinding.check_in_id == check_in.id))
    )
    rows.sort(
        key=lambda row: (
            _SEVERITY_ORDER[row.severity],
            _KIND_ORDER[row.kind],
            row.created_at,
            str(row.id),
        )
    )
    summary = _summary(check_in, len(rows), sum(row.user_action is not None for row in rows))
    return CheckInDetail(
        **summary.model_dump(),
        findings=[_finding_out(row) for row in rows],
        cash_flow=_cash_flow(session, check_in, now.date()),
    )


@router.patch("/{check_in_id}/findings/{finding_id}", responses=error_responses(401, 404, 422))
def update_finding(
    check_in_id: uuid.UUID,
    finding_id: uuid.UUID,
    body: FindingPatch,
    session: UserSession,
    now: Now,
) -> FindingOut:
    """Mark a finding done or dismissed, or undo that with null."""
    # The check-in first, then the finding: the same order a refresh locks them in.
    check_in = session.get(CheckIn, check_in_id, with_for_update=True)
    finding = session.scalars(
        select(CheckInFinding)
        .where(CheckInFinding.id == finding_id, CheckInFinding.check_in_id == check_in_id)
        .with_for_update()
    ).one_or_none()
    if finding is None or check_in is None:
        raise NotFound("Finding not found")
    if body.user_action is not finding.user_action:
        finding.user_action = body.user_action
        finding.user_action_at = now if body.user_action is not None else None
        session.flush()
        settle_status(session, check_in, now)
    session.refresh(finding)  # updated_at comes from the trigger
    return _finding_out(finding)
