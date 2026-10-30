"""One pure finder per finding kind (spec 015 rules 1-7).

Each finder is ``f(facts) -> list[Finding]``: no I/O, no clock, no LLM. The
facts are plain values that ``checkin/facts.py`` reads under RLS (or an eval
fixture supplies). Finders compare the cents they are handed and do the date
arithmetic; every amount they report comes from ``calc/checkin.py``.

A finding's ``key`` names the event it reports (rule 12): the engine uses it
to update a finding it already wrote and to report an event only once.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from decimal import Decimal
from typing import Annotated, Literal, assert_never

from pydantic import BaseModel, ConfigDict, Field

from calc.cashflow import LINES, LineKey
from calc.checkin import change_cents, expected_deferral_cents, goal_pace
from calc.money import rate_pct
from calc.pay_dates import add_months
from db.enums import (
    CalendarKind,
    FindingKind,
    FindingSeverity,
    GoalKind,
    RecurringCadence,
    RecurringStatus,
    RecurringUserStatus,
)

__all__ = [
    "FINDERS",
    "Affects",
    "BalanceFact",
    "DeductionChangePayload",
    "ElectionMismatchPayload",
    "EventFact",
    "Facts",
    "Finding",
    "FindingPayload",
    "GoalFact",
    "GoalOffPacePayload",
    "HealthFact",
    "K401Fact",
    "PayChangePayload",
    "RecurringFact",
    "RecurringPayload",
    "StubFact",
    "UpcomingDeadlinePayload",
    "all_findings",
    "calendar_affects",
    "deduction_change",
    "election_mismatch",
    "goal_off_pace",
    "months_elapsed",
    "pay_change",
    "recurring_changed",
    "recurring_new",
    "recurring_stopped",
    "upcoming_deadline",
]

# What a finding affects: a calculator the user can re-run, or their spending.
Affects = Literal["k401_match", "health_plans", "emergency_fund", "w4", "spending"]

# Rule 1: payrolls round a percentage deferral differently; one cent is not a mismatch.
DEFERRAL_TOLERANCE_CENTS = 1
# Rule 7: a deadline this close is a warning.
SOON_DAYS = 7


class _Fact(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


# ---------------------------------------------------------------- facts


class StubFact(_Fact):
    """A confirmed pay stub (spec 001 ``pay_stubs``)."""

    id: uuid.UUID
    pay_date: dt.date
    period_start: dt.date
    period_end: dt.date
    gross_cents: int
    federal_withholding_cents: int
    social_security_cents: int
    medicare_cents: int
    state_tax_cents: int
    retirement_contribution_cents: int
    medical_premium_cents: int
    other_deductions_cents: int
    net_cents: int

    def line(self, key: LineKey) -> int:
        amount: int = getattr(self, f"{key}_cents")
        return amount


class K401Fact(_Fact):
    """The current ``k401_match`` decision."""

    decision_id: uuid.UUID
    decided_on: dt.date
    contribution_pct: Decimal


class HealthFact(_Fact):
    """The current ``health_plans`` decision's selected plan."""

    decision_id: uuid.UUID
    decided_on: dt.date
    plan_name: str
    premium_per_period_cents: int


class BalanceFact(_Fact):
    as_of: dt.date
    balance_cents: int


class GoalFact(_Fact):
    """An active goal with a linked account and that account's balances, oldest first."""

    id: uuid.UUID
    kind: GoalKind
    decision_id: uuid.UUID | None
    started_on: dt.date
    target_amount_cents: int
    monthly_contribution_cents: int
    balances: list[BalanceFact]


class RecurringFact(_Fact):
    """A recurring charge flagged ``new``, ``changed`` or ``stopped``."""

    id: uuid.UUID
    merchant: str
    cadence: RecurringCadence
    status: RecurringStatus
    user_status: RecurringUserStatus | None
    typical_amount_cents: int
    first_seen: dt.date
    last_seen: dt.date
    # The typical amount the newest earlier finding about this charge reported.
    last_reported_amount_cents: int | None


class EventFact(_Fact):
    """An upcoming calendar event due within 30 days of ``today``."""

    id: uuid.UUID
    kind: CalendarKind
    title: str
    due_at: dt.date
    decision_id: uuid.UUID | None


class Facts(_Fact):
    period: dt.date
    today: dt.date
    # Newest first, at most two.
    pay_stubs: list[StubFact] = Field(default_factory=list, max_length=2)
    k401: K401Fact | None = None
    health: HealthFact | None = None
    w4_decision_id: uuid.UUID | None = None
    goals: list[GoalFact] = Field(default_factory=list)
    recurring: list[RecurringFact] = Field(default_factory=list)
    events: list[EventFact] = Field(default_factory=list)


# ---------------------------------------------------------------- payloads


class _Payload(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    affects: Affects | None


class ElectionMismatchPayload(_Payload):
    kind: Literal["election_mismatch"] = "election_mismatch"
    calculator: Literal["k401_match", "health_plans"]
    pay_stub_id: uuid.UUID
    pay_date: dt.date
    expected_cents: int
    actual_cents: int
    # Actual minus expected.
    difference_cents: int
    # 401(k) only: the elected rate and the stub's, two places.
    elected_pct: Decimal | None = None
    actual_pct: Decimal | None = None
    # Health only.
    plan_name: str | None = None


class GoalOffPacePayload(_Payload):
    kind: Literal["goal_off_pace"] = "goal_off_pace"
    goal_id: uuid.UUID
    started_on: dt.date
    start_balance_cents: int
    monthly_contribution_cents: int
    months_elapsed: int
    expected_cents: int
    balance_cents: int
    balance_as_of: dt.date
    shortfall_cents: int
    target_amount_cents: int


class RecurringPayload(_Payload):
    kind: Literal["recurring_new", "recurring_changed", "recurring_stopped"]
    recurring_charge_id: uuid.UUID
    merchant: str
    cadence: RecurringCadence
    typical_amount_cents: int
    # recurring_changed only, and null when no earlier finding reported an amount.
    previous_amount_cents: int | None = None
    change_cents: int | None = None
    first_seen: dt.date
    last_seen: dt.date
    user_status: RecurringUserStatus | None


class _StubPair(_Payload):
    pay_stub_id: uuid.UUID
    pay_date: dt.date
    previous_pay_stub_id: uuid.UUID
    previous_pay_date: dt.date


class PayChangePayload(_StubPair):
    kind: Literal["pay_change"] = "pay_change"
    gross_cents: int
    previous_gross_cents: int
    gross_change_cents: int
    net_cents: int
    previous_net_cents: int
    net_change_cents: int


class DeductionChangePayload(_StubPair):
    kind: Literal["deduction_change"] = "deduction_change"
    line: LineKey
    label: str
    amount_cents: int
    previous_cents: int
    change_cents: int


class UpcomingDeadlinePayload(_Payload):
    kind: Literal["upcoming_deadline"] = "upcoming_deadline"
    calendar_event_id: uuid.UUID
    calendar_kind: CalendarKind
    title: str
    due_at: dt.date
    days_until: int


FindingPayload = Annotated[
    ElectionMismatchPayload
    | GoalOffPacePayload
    | RecurringPayload
    | PayChangePayload
    | DeductionChangePayload
    | UpcomingDeadlinePayload,
    Field(discriminator="kind"),
]


class Finding(BaseModel):
    model_config = ConfigDict(frozen=True)

    severity: FindingSeverity
    key: str
    decision_id: uuid.UUID | None
    payload: FindingPayload

    @property
    def kind(self) -> FindingKind:
        return FindingKind(self.payload.kind)


# ---------------------------------------------------------------- finders


def _newest_after(facts: Facts, decided_on: dt.date) -> StubFact | None:
    """Rules 1-2: the newest stub, when its whole pay period follows the decision."""
    if not facts.pay_stubs:
        return None
    newest = facts.pay_stubs[0]
    return newest if newest.period_start > decided_on else None


def election_mismatch(facts: Facts) -> list[Finding]:
    """Rules 1-2: the saved 401(k) rate and health plan against the newest pay stub."""
    found: list[Finding] = []
    k401 = facts.k401
    stub = _newest_after(facts, k401.decided_on) if k401 else None
    if k401 is not None and stub is not None:
        expected = expected_deferral_cents(stub.gross_cents, k401.contribution_pct)
        actual = stub.retirement_contribution_cents
        difference = change_cents(actual, expected)
        if abs(difference) > DEFERRAL_TOLERANCE_CENTS:
            found.append(
                Finding(
                    severity=FindingSeverity.ALERT,
                    key=f"election_mismatch:k401_match:{k401.decision_id}:{stub.id}",
                    decision_id=k401.decision_id,
                    payload=ElectionMismatchPayload(
                        affects="k401_match",
                        calculator="k401_match",
                        pay_stub_id=stub.id,
                        pay_date=stub.pay_date,
                        expected_cents=expected,
                        actual_cents=actual,
                        difference_cents=difference,
                        elected_pct=k401.contribution_pct.quantize(Decimal("0.01")),
                        actual_pct=rate_pct(actual, stub.gross_cents),
                    ),
                )
            )
    health = facts.health
    stub = _newest_after(facts, health.decided_on) if health else None
    if health is not None and stub is not None:
        expected, actual = health.premium_per_period_cents, stub.medical_premium_cents
        if actual != expected:
            found.append(
                Finding(
                    severity=FindingSeverity.WARNING,
                    key=f"election_mismatch:health_plans:{health.decision_id}:{stub.id}",
                    decision_id=health.decision_id,
                    payload=ElectionMismatchPayload(
                        affects="health_plans",
                        calculator="health_plans",
                        pay_stub_id=stub.id,
                        pay_date=stub.pay_date,
                        expected_cents=expected,
                        actual_cents=actual,
                        difference_cents=change_cents(actual, expected),
                        plan_name=health.plan_name,
                    ),
                )
            )
    return found


def months_elapsed(start: dt.date, on: dt.date) -> int:
    """Rule 3: the largest ``k >= 0`` with ``add_months(start, k) <= on``."""
    months = (on.year - start.year) * 12 + on.month - start.month
    if months > 0 and add_months(start, months) > on:
        months -= 1
    return max(months, 0)


def goal_off_pace(facts: Facts) -> list[Finding]:
    """Rule 3: the linked account's balance against start plus a contribution a month."""
    found: list[Finding] = []
    for goal in facts.goals:
        if not goal.balances:
            continue
        before = [b for b in goal.balances if b.as_of <= goal.started_on]
        start = before[-1] if before else goal.balances[0]
        current = goal.balances[-1]
        months = months_elapsed(goal.started_on, current.as_of)
        pace = goal_pace(
            start.balance_cents, goal.monthly_contribution_cents, months, current.balance_cents
        )
        if pace.shortfall_cents <= 0 or current.balance_cents >= goal.target_amount_cents:
            continue
        found.append(
            Finding(
                severity=FindingSeverity.WARNING,
                key=f"goal_off_pace:{goal.id}:{facts.period.isoformat()}",
                decision_id=goal.decision_id,
                payload=GoalOffPacePayload(
                    affects="emergency_fund" if goal.kind is GoalKind.EMERGENCY_FUND else None,
                    goal_id=goal.id,
                    started_on=goal.started_on,
                    start_balance_cents=start.balance_cents,
                    monthly_contribution_cents=goal.monthly_contribution_cents,
                    months_elapsed=months,
                    expected_cents=pace.expected_cents,
                    balance_cents=current.balance_cents,
                    balance_as_of=current.as_of,
                    shortfall_cents=pace.shortfall_cents,
                    target_amount_cents=goal.target_amount_cents,
                ),
            )
        )
    return found


def _reportable(facts: Facts, status: RecurringStatus) -> list[RecurringFact]:
    """Rule 4: charges in ``status`` the user has not marked as not recurring."""
    return [
        charge
        for charge in facts.recurring
        if charge.status is status and charge.user_status is not RecurringUserStatus.IGNORED
    ]


def _recurring(
    kind: Literal["recurring_new", "recurring_changed", "recurring_stopped"],
    severity: FindingSeverity,
    charge: RecurringFact,
    previous: int | None = None,
) -> Finding:
    return Finding(
        severity=severity,
        key=f"{kind}:{charge.id}:{charge.last_seen.isoformat()}",
        decision_id=None,
        payload=RecurringPayload(
            kind=kind,
            affects="spending",
            recurring_charge_id=charge.id,
            merchant=charge.merchant,
            cadence=charge.cadence,
            typical_amount_cents=charge.typical_amount_cents,
            previous_amount_cents=previous,
            change_cents=(
                None if previous is None else change_cents(charge.typical_amount_cents, previous)
            ),
            first_seen=charge.first_seen,
            last_seen=charge.last_seen,
            user_status=charge.user_status,
        ),
    )


def recurring_new(facts: Facts) -> list[Finding]:
    """Rule 4: a charge the detector flagged ``new``."""
    return [
        _recurring("recurring_new", FindingSeverity.WARNING, charge)
        for charge in _reportable(facts, RecurringStatus.NEW)
    ]


def recurring_changed(facts: Facts) -> list[Finding]:
    """Rule 4: a repriced charge; a known drop is ``info``, anything else ``warning``."""
    found: list[Finding] = []
    for charge in _reportable(facts, RecurringStatus.CHANGED):
        finding = _recurring(
            "recurring_changed", FindingSeverity.WARNING, charge, charge.last_reported_amount_cents
        )
        change = (
            finding.payload.change_cents if isinstance(finding.payload, RecurringPayload) else None
        )
        if change is not None and change < 0:
            finding = finding.model_copy(update={"severity": FindingSeverity.INFO})
        found.append(finding)
    return found


def recurring_stopped(facts: Facts) -> list[Finding]:
    """Rule 4: a charge that stopped (or was cancelled, per ``user_status``)."""
    return [
        _recurring("recurring_stopped", FindingSeverity.INFO, charge)
        for charge in _reportable(facts, RecurringStatus.STOPPED)
    ]


def _pair(facts: Facts) -> tuple[StubFact, StubFact] | None:
    if len(facts.pay_stubs) < 2:
        return None
    return facts.pay_stubs[0], facts.pay_stubs[1]


def pay_change(facts: Facts) -> list[Finding]:
    """Rule 5: gross pay differs between the two newest stubs."""
    pair = _pair(facts)
    if pair is None:
        return []
    newest, previous = pair
    gross_change = change_cents(newest.gross_cents, previous.gross_cents)
    if gross_change == 0:
        return []
    return [
        Finding(
            severity=FindingSeverity.WARNING if gross_change < 0 else FindingSeverity.INFO,
            key=f"pay_change:{newest.id}",
            decision_id=facts.w4_decision_id,
            payload=PayChangePayload(
                affects="w4",
                pay_stub_id=newest.id,
                pay_date=newest.pay_date,
                previous_pay_stub_id=previous.id,
                previous_pay_date=previous.pay_date,
                gross_cents=newest.gross_cents,
                previous_gross_cents=previous.gross_cents,
                gross_change_cents=gross_change,
                net_cents=newest.net_cents,
                previous_net_cents=previous.net_cents,
                net_change_cents=change_cents(newest.net_cents, previous.net_cents),
            ),
        )
    ]


# Rule 6: the lines a deduction change reports, and what each affects.
DEDUCTION_LINES: tuple[tuple[LineKey, Affects | None], ...] = (
    ("federal_withholding", "w4"),
    ("state_tax", None),
    ("retirement_contribution", "k401_match"),
    ("medical_premium", "health_plans"),
    ("other_deductions", None),
)
_LABELS = {spec.key: spec.label for spec in LINES}


def _decision_for(facts: Facts, affects: Affects | None) -> uuid.UUID | None:
    if affects == "k401_match":
        return facts.k401.decision_id if facts.k401 else None
    if affects == "health_plans":
        return facts.health.decision_id if facts.health else None
    if affects == "w4":
        return facts.w4_decision_id
    return None


def deduction_change(facts: Facts) -> list[Finding]:
    """Rule 6: one finding per elected or withheld line that changed."""
    pair = _pair(facts)
    if pair is None:
        return []
    newest, previous = pair
    found: list[Finding] = []
    for line, affects in DEDUCTION_LINES:
        amount, before = newest.line(line), previous.line(line)
        if amount == before:
            continue
        found.append(
            Finding(
                severity=FindingSeverity.INFO,
                key=f"deduction_change:{newest.id}:{line}",
                decision_id=_decision_for(facts, affects),
                payload=DeductionChangePayload(
                    affects=affects,
                    pay_stub_id=newest.id,
                    pay_date=newest.pay_date,
                    previous_pay_stub_id=previous.id,
                    previous_pay_date=previous.pay_date,
                    line=line,
                    label=_LABELS[line],
                    amount_cents=amount,
                    previous_cents=before,
                    change_cents=change_cents(amount, before),
                ),
            )
        )
    return found


def calendar_affects(kind: CalendarKind) -> Affects:
    """Rule 7: which calculator a calendar kind belongs to.

    A ``match`` rather than a dict so mypy checks it covers every kind: a new
    ``CalendarKind`` without a case fails type checking (issue 170, where
    ``w4_submit`` had no entry and its finding no Affects link).
    """
    match kind:
        case CalendarKind.ELECTION_CHECK:
            return "k401_match"
        case CalendarKind.ENROLLMENT_DEADLINE | CalendarKind.OPEN_ENROLLMENT:
            return "health_plans"
        case CalendarKind.GOAL_CONTRIBUTION | CalendarKind.GOAL_REVIEW | CalendarKind.GOAL_TARGET:
            return "emergency_fund"
        case CalendarKind.TAX_SEASON | CalendarKind.W4_SUBMIT:
            return "w4"
        case _:
            assert_never(kind)


def upcoming_deadline(facts: Facts) -> list[Finding]:
    """Rule 7: each upcoming event the facts hold (due within 30 days)."""
    found: list[Finding] = []
    for event in facts.events:
        days = (event.due_at - facts.today).days
        found.append(
            Finding(
                severity=FindingSeverity.WARNING if days <= SOON_DAYS else FindingSeverity.INFO,
                key=f"upcoming_deadline:{event.id}",
                decision_id=event.decision_id,
                payload=UpcomingDeadlinePayload(
                    affects=calendar_affects(event.kind),
                    calendar_event_id=event.id,
                    calendar_kind=event.kind,
                    title=event.title,
                    due_at=event.due_at,
                    days_until=days,
                ),
            )
        )
    return found


Finder = Callable[[Facts], list[Finding]]

# In rule order; ``all_findings`` reports in this order.
FINDERS: tuple[Finder, ...] = (
    election_mismatch,
    goal_off_pace,
    recurring_new,
    recurring_changed,
    recurring_stopped,
    pay_change,
    deduction_change,
    upcoming_deadline,
)


def all_findings(facts: Facts) -> list[Finding]:
    """Every finder's findings, in rule order; a repeated key is a bug and raises."""
    found = [finding for finder in FINDERS for finding in finder(facts)]
    keys = [finding.key for finding in found]
    if len(set(keys)) != len(keys):
        raise ValueError(f"finders produced a repeated key: {sorted(keys)}")
    return found
