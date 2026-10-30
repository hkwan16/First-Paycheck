"""The plan as one HTML page for WeasyPrint (spec 016 rules 11-12). Worker only.

The template (``templates/plan.html.j2``) renders ``app.plan.PlanOut`` and
writes numbers with ``verify.format``, the same forms the explanations use.
It formats; it never computes. The output carries no ids and no timestamps
besides the preparation date, so the same plan renders the same bytes.
"""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined

from app.plan import PlanFigure, PlanOut
from db.enums import CalculatorKind, CalendarKind, GoalKind, GoalStatus
from verify.format import dollars, net_cost, percent

__all__ = ["STALE_LABEL", "render_html"]

TEMPLATES = Path(__file__).parent / "templates"

CALCULATOR_TITLES = {
    CalculatorKind.EMERGENCY_FUND: "Emergency fund",
    CalculatorKind.K401_MATCH: "401(k) contribution",
    CalculatorKind.HEALTH_PLANS: "Health plan",
    CalculatorKind.W4: "Form W-4",
}
EXPLANATION_LABELS = {
    "verified": "Verified against the calculator",
    "fallback": "Plain calculator summary (the written explanation did not pass the check)",
    "none": "Not explained yet",
}
# Spec 016 rule 11: an explanation written from figures that changed since
# (spec 008 rule 19a) is labeled, and its text is not printed.
STALE_LABEL = (
    "Out of date: written from figures that have changed since. Open Why in First Paycheck"
    " to write it again."
)
GOAL_TITLES = {GoalKind.EMERGENCY_FUND: "Emergency fund", GoalKind.CUSTOM: "Savings goal"}
GOAL_STATUSES = {
    GoalStatus.ACTIVE: "Active",
    GoalStatus.PAUSED: "Paused",
    GoalStatus.REACHED: "Reached",
}
# Months to target is null past the calculator's 120-month horizon (spec 011).
NO_COUNT = "Not within 10 years"


def long_date(value: dt.date) -> str:
    """``2026-10-31`` -> ``Oct 31, 2026``."""
    return f"{value:%b} {value.day}, {value.year}"


def figure_value(figure: PlanFigure) -> str:
    value = figure.value
    if figure.kind == "money" and isinstance(value, int):
        return dollars(value)
    if figure.kind == "net_cost" and isinstance(value, int):
        return net_cost(value)
    if figure.kind == "percent" and isinstance(value, str):
        return percent(Decimal(value))
    if figure.kind == "count" and (value is None or isinstance(value, int)):
        return NO_COUNT if value is None else str(value)
    if figure.kind == "text" and isinstance(value, str):
        return value
    raise ValueError(f"{figure.key} holds {value!r}, which is not a {figure.kind} value")


def _environment() -> Environment:
    environment = Environment(
        loader=FileSystemLoader(TEMPLATES),
        autoescape=True,
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=True,
    )
    environment.filters.update(
        money=dollars,
        pct=lambda value: percent(Decimal(value)),
        long_date=long_date,
        figure=figure_value,
    )
    return environment


_ENVIRONMENT = _environment()


def render_html(plan: PlanOut, prepared_at: dt.datetime) -> str:
    """The page for ``plan``, prepared at ``prepared_at`` (its UTC date is printed)."""
    calculators: dict[uuid.UUID, CalculatorKind] = {
        decision.id: decision.calculator for decision in plan.decisions
    }
    return _ENVIRONMENT.get_template("plan.html.j2").render(
        plan=plan,
        prepared_on=prepared_at.astimezone(dt.UTC).date(),
        calculator_titles=CALCULATOR_TITLES,
        explanation_labels=EXPLANATION_LABELS,
        stale_label=STALE_LABEL,
        goal_titles=GOAL_TITLES,
        goal_statuses=GOAL_STATUSES,
        calendar_kinds=CalendarKind,
        decision_calculators=calculators,
    )
