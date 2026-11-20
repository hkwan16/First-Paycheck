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
from app.routers.explain import is_explainable
from db.enums import CalculatorKind, CalendarKind, GoalKind, GoalStatus
from verify.format import dollars, net_cost, percent, refund

__all__ = ["REVIEW_NOTE", "STALE_LABEL", "render_html"]

TEMPLATES = Path(__file__).parent / "templates"

# Spec 016 rule 11a (issue 239): the PDF is the Plan page on paper, so it says
# what the Plan page says. These are web/src/lib/decisions.ts:CALCULATOR_LABELS,
# which web/src/components/screens/plan/plan-pdf-words.test.ts checks against
# the rendered fixture.
CALCULATOR_TITLES = {
    CalculatorKind.EMERGENCY_FUND: "Emergency fund",
    CalculatorKind.K401_MATCH: "401(k) match",
    CalculatorKind.HEALTH_PLANS: "Health plan",
    CalculatorKind.W4: "W-4, federal only",
}
# A decision's explanation on page 1, as the Plan page words it, with the way
# back to the Why page a printout can give.
EXPLANATION_LABELS = {
    "verified": (
        "Explained under Why, with sources. We checked every number in it against the"
        " decision you saved."
    ),
    "fallback": "We could not write this explanation. Open Why in First Paycheck to try again.",
    "none": "No explanation yet. Open Why in First Paycheck to write one.",
}
# The same on page 2, above the explanation itself, as the Why page's notes say it.
WHY_LABELS = {
    "verified": "We checked every number here against the decision you saved.",
    "fallback": (
        "We could not write an explanation that matches your numbers, so here are the"
        " numbers you saved."
    ),
}
# Spec 016 rule 11: an explanation written from figures that changed since
# (spec 008 rule 19a) is labeled, and its text is not printed.
STALE_LABEL = (
    "Written before some of your information changed. Open Why in First Paycheck to update"
    " the explanation."
)
# Spec 016 rule 3a: a decision whose inputs changed since it was saved (spec 007
# rules 19a-19e) prints its reasons and this, in place of figures worked out before.
REVIEW_NOTE = (
    "Its numbers were worked out before this changed, so they are not shown here. Open First"
    " Paycheck to review it and save it again."
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
    if figure.kind == "refund" and isinstance(value, int):
        return refund(value)
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


def render_html(plan: PlanOut) -> str:
    """The page for ``plan``, prepared on its ``as_of``, the person's today (spec 019)."""
    calculators: dict[uuid.UUID, CalculatorKind] = {
        decision.id: decision.calculator for decision in plan.decisions
    }
    return _ENVIRONMENT.get_template("plan.html.j2").render(
        plan=plan,
        prepared_on=plan.as_of,
        calculator_titles=CALCULATOR_TITLES,
        # An emergency fund is never explained (spec 011), so it has no explanation line.
        explained_calculators={kind for kind in CalculatorKind if is_explainable(kind)},
        explanation_labels=EXPLANATION_LABELS,
        why_labels=WHY_LABELS,
        stale_label=STALE_LABEL,
        review_note=REVIEW_NOTE,
        goal_titles=GOAL_TITLES,
        goal_statuses=GOAL_STATUSES,
        calendar_kinds=CalendarKind,
        decision_calculators=calculators,
    )
