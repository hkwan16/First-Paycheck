"""Which saved decisions need review, and the words for why (spec 007 rules
19a-19e, issue 222).

Some of a decision's inputs are not what the person chose but what its step
read when it was saved: the pay schedule, the salary, the tax year, the plan
details, and for the W-4 the saved 401(k) rate and health premium. When one of
those changes, the saved result is figured for a paycheck or a year that is no
longer the person's. ``review`` compares each of them, as stored, with the
value its step would send now (``load_context``), and words every difference
once, so the steps, the side nav, the Plan page and the PDF all say the same.
It is computed on read and never stored: a decision is immutable (rule 9).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import column, select, table
from sqlalchemy.orm import Session

from app.pay_schedule import pay_schedule
from app.salary_review import SalaryReview, load_salary_review
from calc.k401 import MatchTier
from calc.registry import calculator
from calc.types import STORED
from db.enums import CalculatorKind
from db.models import Decision, Profile
from db.pay_stubs import newest_pay_stub
from verify.format import dollars, percent

__all__ = [
    "CONTEXT_INPUTS",
    "ReviewContext",
    "ReviewInput",
    "ReviewReason",
    "load_context",
    "review",
]

ReviewInput = Literal[
    "pay_periods_per_year",
    "salary_cents",
    "tax_year",
    "filing_status",
    "age",
    "match_tiers",
    "k401_contribution_pct",
    "health_premium_per_paycheck_cents",
]


class ReviewReason(BaseModel):
    """One reason a saved decision needs review (rule 19b)."""

    # changed: a context input differs from what was saved (rule 19b).
    # salary_unconfirmed: the salary question is open (rule 19c).
    kind: Literal["changed", "salary_unconfirmed"]
    input: ReviewInput
    # One plain sentence (rule 19d), the same on every surface.
    text: str


@dataclass(frozen=True)
class ReviewContext:
    """What each step would read now (rule 19a); None where nothing says yet."""

    salary_cents: int | None
    pay_periods_per_year: int | None
    tax_year: int | None
    filing_status: str | None
    birth_year: int | None
    # None while the profile has no match formula (the 401(k) step asks for one).
    match_tiers: tuple[MatchTier, ...] | None
    # The W-4 sends 0 for a decision not saved yet.
    k401_contribution_pct: Decimal
    health_premium_per_paycheck_cents: int
    salary_review: SalaryReview | None


# Rule 19a's table, in its order: the reasons come out in this order too.
CONTEXT_INPUTS: dict[CalculatorKind, tuple[ReviewInput, ...]] = {
    CalculatorKind.EMERGENCY_FUND: ("pay_periods_per_year",),
    CalculatorKind.K401_MATCH: (
        "pay_periods_per_year",
        "salary_cents",
        "tax_year",
        "filing_status",
        "age",
        "match_tiers",
    ),
    CalculatorKind.HEALTH_PLANS: (
        "pay_periods_per_year",
        "salary_cents",
        "tax_year",
        "filing_status",
    ),
    CalculatorKind.W4: (
        "pay_periods_per_year",
        "salary_cents",
        "tax_year",
        "age",
        "k401_contribution_pct",
        "health_premium_per_paycheck_cents",
    ),
}

FILING_WORDS = {
    "single": "single",
    "married_filing_jointly": "married filing jointly",
    "head_of_household": "head of household",
}


@dataclass(frozen=True)
class _Known:
    """A value the step would send now (which may itself be None, like a W-4 age)."""

    value: Any


def _known(value: Any) -> _Known | None:
    return None if value is None else _Known(value)


def _age(context: ReviewContext) -> int | None:
    """The age the cards send: the tax year less the birth year, a difference of
    years; none without a birth year or with one after the tax year."""
    if context.tax_year is None or context.birth_year is None:
        return None
    if context.birth_year > context.tax_year:
        return None
    return context.tax_year - context.birth_year


def _age_now(kind: CalculatorKind, context: ReviewContext) -> _Known | None:
    if context.tax_year is None:
        return None
    age = _age(context)
    # The 401(k) step cannot calculate without an age; the W-4 sends none.
    if age is None and kind == CalculatorKind.K401_MATCH:
        return None
    return _Known(age)


def _tiers(tiers: Sequence[MatchTier]) -> tuple[tuple[Decimal, Decimal], ...]:
    return tuple((tier.employee_pct_upto, tier.employer_pct) for tier in tiers)


def _tiers_text(tiers: Sequence[MatchTier]) -> str:
    """The match formula as the 401(k) step says it: "100% of the first 3%, then 50% up to 5%"."""
    if not tiers:
        return "no match"
    return ", then ".join(
        f"{percent(tier.employer_pct)} of the first {percent(tier.employee_pct_upto)}"
        if index == 0
        else f"{percent(tier.employer_pct)} up to {percent(tier.employee_pct_upto)}"
        for index, tier in enumerate(tiers)
    )


def _age_text(saved: int | None, now: int | None) -> str:
    if saved is None:
        return "Your birth year was added."
    if now is None:
        return "Your birth year was removed."
    return f"Your age at the end of the tax year changed from {saved} to {now}."


@dataclass(frozen=True)
class _Check:
    """How one context input is read now, compared, and said (rules 19a, 19b, 19d)."""

    now: Callable[[CalculatorKind, ReviewContext], _Known | None]
    words: Callable[[Any, Any], str]
    same: Callable[[Any, Any], bool] = lambda saved, now: bool(saved == now)


_CHECKS: dict[ReviewInput, _Check] = {
    "pay_periods_per_year": _Check(
        now=lambda _, c: _known(c.pay_periods_per_year),
        words=lambda saved, now: (
            f"Your pay schedule changed from {saved} to {now} paychecks a year."
        ),
    ),
    "salary_cents": _Check(
        now=lambda _, c: _known(c.salary_cents),
        words=lambda saved, now: (
            f"Your yearly salary changed from {dollars(saved)} to {dollars(now)}."
        ),
    ),
    "tax_year": _Check(
        now=lambda _, c: _known(c.tax_year),
        words=lambda saved, now: f"The tax year changed from {saved} to {now}.",
    ),
    "filing_status": _Check(
        now=lambda _, c: _known(c.filing_status),
        words=lambda saved, now: (
            f"Your filing status changed from {FILING_WORDS[saved]} to {FILING_WORDS[now]}."
        ),
    ),
    "age": _Check(now=_age_now, words=_age_text),
    "match_tiers": _Check(
        now=lambda _, c: _known(c.match_tiers),
        words=lambda saved, now: (
            f"Your employer match changed from {_tiers_text(saved)} to {_tiers_text(now)}."
        ),
        same=lambda saved, now: _tiers(saved) == _tiers(now),
    ),
    "k401_contribution_pct": _Check(
        now=lambda _, c: _Known(c.k401_contribution_pct),
        words=lambda saved, now: (
            f"Your 401(k) decision changed from {percent(saved)} to {percent(now)}."
        ),
    ),
    "health_premium_per_paycheck_cents": _Check(
        now=lambda _, c: _Known(c.health_premium_per_paycheck_cents),
        words=lambda saved, now: (
            f"Your health plan's premium changed from {dollars(saved)} to {dollars(now)}"
            " a paycheck."
        ),
    ),
}


def _unconfirmed(question: SalaryReview) -> ReviewReason:
    return ReviewReason(
        kind="salary_unconfirmed",
        input="salary_cents",
        text=(
            f"Your newest pay stub comes to {dollars(question.annual_salary_cents)} a year,"
            f" not the {dollars(question.salary_cents)} in your plan details. Choose which"
            " salary to use."
        ),
    )


def review(
    kind: CalculatorKind, inputs: dict[str, Any], context: ReviewContext
) -> list[ReviewReason]:
    """Why a current decision with these stored ``inputs`` needs review; empty when
    nothing does (rules 19b and 19c)."""
    # The registered model reads an older row's missing fields as their defaults.
    saved = calculator(kind).input_model.model_validate(inputs, context=STORED)
    reasons = []
    for name in CONTEXT_INPUTS[kind]:
        check = _CHECKS[name]
        now = check.now(kind, context)
        if now is None:
            continue
        value = getattr(saved, name)
        if not check.same(value, now.value):
            reasons.append(
                ReviewReason(kind="changed", input=name, text=check.words(value, now.value))
            )
    if context.salary_review is not None and "salary_cents" in CONTEXT_INPUTS[kind]:
        reasons.append(_unconfirmed(context.salary_review))
    return reasons


# ---------------------------------------------------------------- reads

_current_decisions = table("current_decisions", column("id"))


def _current(session: Session, kind: CalculatorKind) -> Decision | None:
    return session.scalars(
        select(Decision).where(
            Decision.calculator == kind, Decision.id.in_(select(_current_decisions.c.id))
        )
    ).first()


def _k401_pct(decision: Decision | None) -> Decimal:
    """The W-4's 401(k) rate: the current 401(k) decision's, else 0."""
    if decision is None:
        return Decimal(0)
    return Decimal(str(decision.inputs["contribution_pct"]))


def _premium(decision: Decision | None) -> int:
    """The W-4's premium: the current health plan decision's chosen plan's, else 0."""
    if decision is None:
        return 0
    index = decision.inputs.get("selected_plan_index")
    if index is None:
        return 0
    return int(decision.inputs["plans"][index]["premium_per_period_cents"])


def _words(value: StrEnum | None) -> str | None:
    return None if value is None else value.value


def load_context(session: Session) -> ReviewContext:
    """What each step would read now, in the user's session (rule 19b).

    Row-level security shows a user session only its own profile, so the one
    row there is is the user's; a session that sees more fails here.
    """
    profile = session.scalars(select(Profile)).one_or_none()
    schedule = pay_schedule(session, profile)
    newest = newest_pay_stub(session)
    tiers = [] if profile is None else profile.match_tiers
    return ReviewContext(
        salary_cents=None if profile is None else profile.salary_cents,
        pay_periods_per_year=None if schedule is None else schedule.periods_per_year,
        tax_year=None if newest is None else newest.tax_year,
        filing_status=None if profile is None else _words(profile.filing_status),
        birth_year=None if profile is None else profile.birth_year,
        match_tiers=tuple(MatchTier.model_validate(tier) for tier in tiers) or None,
        k401_contribution_pct=_k401_pct(_current(session, CalculatorKind.K401_MATCH)),
        health_premium_per_paycheck_cents=_premium(_current(session, CalculatorKind.HEALTH_PLANS)),
        salary_review=load_salary_review(session, profile),
    )
