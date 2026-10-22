"""The check-in engine (spec 015 rules 8-15 and 23).

``reconcile`` is pure: given what a check-in holds, what the finders found and
which keys other check-ins already reported, it says what to insert, update,
retract and drop. ``run_check_in`` is the thin writer the ``checkin.monthly``
job calls in one user session, under RLS. ``queue_refresh`` is how a finished
recurring detection asks for a refresh, and ``queue_check_in_now`` how the
user does (``POST /check-ins``). ``settle_status`` keeps a check-in's
status in step with its findings, for the engine and ``PATCH``.
"""

from __future__ import annotations

import calendar
import datetime as dt
import uuid
from collections.abc import Collection, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.orm import Session

from checkin.facts import load_facts
from checkin.findings import Finding, all_findings
from db.enums import (
    CheckinStatus,
    CheckinTrigger,
    FindingKind,
    JobKind,
    RecurringStatus,
    RecurringUserStatus,
)
from db.models import CheckIn, CheckInFinding, Job, RecurringCharge
from jobs import queue

__all__ = [
    "CONDITIONS",
    "Changes",
    "CheckInRun",
    "Existing",
    "Trigger",
    "checkin_key",
    "month_end",
    "monthly_payload",
    "queue_check_in_now",
    "queue_refresh",
    "reconcile",
    "run_check_in",
    "settle_status",
    "subject_gone",
]

Trigger = Literal["schedule", "sync"]

# Rule 10.4: kinds that stop being true when their facts change, so an
# unhandled one that no finder produces any more is retracted.
CONDITIONS = frozenset(
    {FindingKind.ELECTION_MISMATCH, FindingKind.GOAL_OFF_PACE, FindingKind.UPCOMING_DEADLINE}
)
# Events about a recurring charge: their subject is the charge's row.
RECURRING_EVENTS = frozenset(
    {FindingKind.RECURRING_NEW, FindingKind.RECURRING_CHANGED, FindingKind.RECURRING_STOPPED}
)


@dataclass(frozen=True)
class Existing:
    """A finding already on the check-in being refreshed."""

    id: uuid.UUID
    key: str
    kind: FindingKind
    # True when the user marked it done or dismissed.
    handled: bool
    # True when what it reports on no longer exists (``subject_gone``).
    subject_gone: bool = False


def subject_gone(
    kind: FindingKind, payload: dict[str, Any], charge_ids: Collection[uuid.UUID]
) -> bool:
    """Rule 10.4: a recurring finding whose charge is no longer one of the
    user's (it was detected only from an unlinked institution, spec 017 rule 14).

    Other kinds report on pay stubs, decisions, goals and calendar events, which
    unlinking never deletes.
    """
    if kind not in RECURRING_EVENTS:
        return False
    try:
        charge_id = uuid.UUID(str(payload.get("recurring_charge_id")))
    except ValueError:
        return True
    return charge_id not in charge_ids


@dataclass(frozen=True)
class Changes:
    insert: list[Finding] = field(default_factory=list)
    update: list[tuple[uuid.UUID, Finding]] = field(default_factory=list)
    retract: list[uuid.UUID] = field(default_factory=list)
    dropped: list[Finding] = field(default_factory=list)


def reconcile(
    existing: Sequence[Existing],
    candidates: Sequence[Finding],
    reported_elsewhere: Collection[str],
) -> Changes:
    """Rule 10: what a refresh does to a check-in's findings."""
    changes = Changes()
    by_key = {row.key: row for row in existing}
    produced: set[str] = set()
    for finding in candidates:
        if finding.key in reported_elsewhere:
            changes.dropped.append(finding)
            continue
        produced.add(finding.key)
        row = by_key.get(finding.key)
        if row is None:
            changes.insert.append(finding)
        else:
            changes.update.append((row.id, finding))
    for row in existing:
        if row.key in produced or row.handled:
            continue
        if row.kind in CONDITIONS or row.subject_gone:
            changes.retract.append(row.id)
    return changes


@dataclass(frozen=True)
class CheckInRun:
    outcome: Literal["created", "refreshed", "skipped"]
    check_in_id: uuid.UUID | None = None
    inserted: int = 0
    updated: int = 0
    retracted: int = 0
    dropped: int = 0
    marked_active: int = 0

    def as_job_result(self) -> dict[str, Any]:
        return {
            "outcome": self.outcome,
            "check_in_id": str(self.check_in_id) if self.check_in_id else None,
            "inserted": self.inserted,
            "updated": self.updated,
            "retracted": self.retracted,
            "dropped": self.dropped,
            "marked_active": self.marked_active,
        }


def checkin_key(period: dt.date) -> str:
    """The idempotency key of a user's scheduled check-in job for ``period``'s month."""
    return f"checkin.monthly:{period:%Y-%m}"


def monthly_payload(period: dt.date, trigger: Trigger) -> dict[str, str]:
    """The ``checkin.monthly`` payload (rule 16)."""
    return {"period": period.isoformat(), "trigger": trigger}


def month_end(period: dt.date) -> dt.date:
    """The last day of ``period``'s month."""
    return period.replace(day=calendar.monthrange(period.year, period.month)[1])


def _lock(session: Session, key: str) -> None:
    session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": key})


def _scheduled(session: Session, period: dt.date) -> CheckIn | None:
    return session.scalars(
        select(CheckIn)
        .where(CheckIn.period == period, CheckIn.triggered_by == CheckinTrigger.SCHEDULE)
        .with_for_update()
    ).one_or_none()


def _row(user_id: uuid.UUID, check_in_id: uuid.UUID, finding: Finding) -> CheckInFinding:
    return CheckInFinding(
        user_id=user_id,
        check_in_id=check_in_id,
        kind=finding.kind,
        severity=finding.severity,
        key=finding.key,
        decision_id=finding.decision_id,
        payload=finding.payload.model_dump(mode="json"),
    )


def settle_status(session: Session, check_in: CheckIn, now: dt.datetime) -> None:
    """Rule 13: completed when every finding (at least one) has a user action."""
    total, handled = session.execute(
        select(func.count(), func.count(CheckInFinding.user_action)).where(
            CheckInFinding.check_in_id == check_in.id
        )
    ).one()
    status = CheckinStatus.COMPLETED if total and total == handled else CheckinStatus.OPEN
    if status is check_in.status:
        return
    check_in.status = status
    check_in.completed_at = now if status is CheckinStatus.COMPLETED else None
    session.flush()


def run_check_in(
    session: Session,
    user_id: uuid.UUID,
    period: dt.date,
    *,
    today: dt.date,
    now: dt.datetime,
    trigger: Trigger,
) -> CheckInRun:
    """Rules 8-11 and 13: get or create the month's check-in and refresh it."""
    # Two refreshes for one user never interleave, nor does a refresh with a
    # detection run that could flag a charge this run is about to consume.
    _lock(session, f"checkin:{user_id}")
    _lock(session, f"recurring.detect:{user_id}")
    check_in = _scheduled(session, period)
    outcome: Literal["created", "refreshed"] = "refreshed"
    if check_in is None:
        if trigger != "schedule":
            return CheckInRun(outcome="skipped")
        check_in = CheckIn(user_id=user_id, period=period, triggered_by=CheckinTrigger.SCHEDULE)
        session.add(check_in)
        session.flush()
        outcome = "created"
    elif check_in.status is not CheckinStatus.OPEN:
        return CheckInRun(outcome="skipped", check_in_id=check_in.id)

    facts = load_facts(session, period, today)
    candidates = all_findings(facts)
    rows = {
        row.id: row
        for row in session.scalars(
            select(CheckInFinding).where(CheckInFinding.check_in_id == check_in.id)
        )
    }
    elsewhere = set(
        session.scalars(
            select(CheckInFinding.key).where(
                CheckInFinding.check_in_id != check_in.id,
                CheckInFinding.key.in_([finding.key for finding in candidates]),
            )
        )
    )
    charge_ids = set(session.scalars(select(RecurringCharge.id)))
    changes = reconcile(
        [
            Existing(
                id=row.id,
                key=row.key,
                kind=row.kind,
                handled=row.user_action is not None,
                subject_gone=subject_gone(row.kind, row.payload, charge_ids),
            )
            for row in rows.values()
        ],
        candidates,
        elsewhere,
    )
    for finding in changes.insert:
        session.add(_row(user_id, check_in.id, finding))
    for row_id, finding in changes.update:
        row = rows[row_id]
        row.severity = finding.severity
        row.decision_id = finding.decision_id
        row.payload = finding.payload.model_dump(mode="json")
    if changes.retract:
        session.execute(delete(CheckInFinding).where(CheckInFinding.id.in_(changes.retract)))

    # Rule 11: surfacing consumes the new and changed flags.
    surfaced = [
        charge.id
        for charge in facts.recurring
        if charge.status in (RecurringStatus.NEW, RecurringStatus.CHANGED)
        and charge.user_status is not RecurringUserStatus.IGNORED
    ]
    marked = 0
    if surfaced:
        marked = len(
            session.scalars(
                update(RecurringCharge)
                .where(
                    RecurringCharge.id.in_(surfaced),
                    RecurringCharge.status.in_((RecurringStatus.NEW, RecurringStatus.CHANGED)),
                )
                .values(status=RecurringStatus.ACTIVE)
                .returning(RecurringCharge.id)
            ).all()
        )
    session.flush()
    settle_status(session, check_in, now)
    return CheckInRun(
        outcome=outcome,
        check_in_id=check_in.id,
        inserted=len(changes.insert),
        updated=len(changes.update),
        retracted=len(changes.retract),
        dropped=len(changes.dropped),
        marked_active=marked,
    )


def queue_refresh(session: Session, user_id: uuid.UUID, today: dt.date) -> uuid.UUID | None:
    """Rule 15: queue a ``sync`` refresh when this month's check-in is open."""
    period = today.replace(day=1)
    open_now = session.scalar(
        select(CheckIn.id).where(
            CheckIn.period == period,
            CheckIn.triggered_by == CheckinTrigger.SCHEDULE,
            CheckIn.status == CheckinStatus.OPEN,
        )
    )
    if open_now is None:
        return None
    return queue.enqueue_unless_queued(
        session,
        user_id=user_id,
        kind=JobKind.CHECKIN_MONTHLY,
        payload=monthly_payload(period, "sync"),
    )


def queue_check_in_now(session: Session, user_id: uuid.UUID, period: dt.date) -> uuid.UUID:
    """Rule 23: the month's scheduled job, queued early, or a refresh after it.

    The first request of the month queues the keyed job the tick would have
    queued (and two concurrent ones still make one). After that, the user's
    waiting job with the same payload answers (the keyed one until it starts),
    else a new unkeyed job refreshes the check-in the keyed one built.
    """
    payload = monthly_payload(period, "schedule")
    key = checkin_key(period)
    keyed = session.scalar(select(Job.id).where(Job.user_id == user_id, Job.idempotency_key == key))
    if keyed is None:
        return queue.enqueue(
            session,
            user_id=user_id,
            kind=JobKind.CHECKIN_MONTHLY,
            payload=payload,
            idempotency_key=key,
        )
    return queue.enqueue_unless_queued(
        session, user_id=user_id, kind=JobKind.CHECKIN_MONTHLY, payload=payload
    )
