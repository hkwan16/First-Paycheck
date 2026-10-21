"""What the explain prompt is given about a decision (spec 008 rule 7).

Facts are the decision's own numbers, formatted the way the verifier reads
them back; every fact passes ``verify_explanation`` by construction (a test
checks this on every spec 006 example). Labels carry no numbers.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from calc.k401 import K401MatchInput, K401MatchResult
from db.enums import CalculatorKind
from llm.schemas import ExplainCitation, ExplainContext, ExplainFact
from retrieval.benefits_search import BenefitsPassage
from retrieval.citations import Citation
from verify.format import dollars, percent

__all__ = ["BENEFITS_PASSAGES", "BENEFITS_QUERIES", "explain_context", "k401_notes"]

# The full-text query run over the user's benefits text for each calculator.
BENEFITS_QUERIES: dict[CalculatorKind, str] = {
    CalculatorKind.K401_MATCH: "401(k) retirement match vesting",
}
BENEFITS_PASSAGES = 3

CAPPED_NOTE = (
    "The contribution rate asks for more than the yearly 401(k) contribution limit, so"
    " contributions stop once the limit is reached; a plan that matches each paycheck"
    " may stop matching then too."
)
COMPENSATION_NOTE = (
    "The salary is above the yearly compensation limit, so the employer match is figured"
    " on pay up to that limit."
)
NO_MATCH_NOTE = "The plan has no employer match."


def k401_notes(result: K401MatchResult, *, has_match: bool) -> list[str]:
    notes = []
    if not has_match:
        notes.append(NO_MATCH_NOTE)
    if result.capped:
        notes.append(CAPPED_NOTE)
    if result.compensation_capped:
        notes.append(COMPENSATION_NOTE)
    return notes


def _k401_facts(data: K401MatchInput, result: K401MatchResult) -> list[ExplainFact]:
    def fact(label: str, value: str) -> ExplainFact:
        return ExplainFact(label=label, value=value)

    facts = [fact("Your contribution rate", percent(data.contribution_pct))]
    if data.match_tiers:
        facts += [
            fact("Contribution rate that earns the full match", percent(result.full_match_pct)),
            fact(
                "Employer match per year at your rate", dollars(result.employer_match_cents_current)
            ),
            fact(
                "Employer match per year at the full-match rate",
                dollars(result.employer_match_cents_full),
            ),
            fact("Match you miss per year", dollars(result.missed_cents)),
            fact(
                "Extra per paycheck before tax at the full-match rate",
                dollars(result.per_paycheck_cost_delta_cents),
            ),
            fact(
                "Extra per paycheck after federal income tax",
                dollars(result.per_paycheck_after_tax_cost_cents),
            ),
        ]
    facts += [
        fact("Federal marginal tax rate used", percent(result.marginal_rate_used)),
        fact("Your yearly contribution", dollars(result.employee_annual_cents_current)),
    ]
    if data.match_tiers:
        facts.append(
            fact(
                "Yearly contribution at the full-match rate",
                dollars(result.employee_annual_cents_full),
            )
        )
    facts += [
        fact("Yearly 401(k) contribution limit", dollars(result.deferral_limit_cents)),
        fact("Salary", dollars(data.salary_cents)),
        fact("Paychecks per year", str(data.pay_periods_per_year)),
        fact("Tax year", str(data.tax_year)),
    ]
    previous = None
    for tier in data.match_tiers:
        share = percent(tier.employer_pct)
        upto = percent(tier.employee_pct_upto)
        if previous is None:
            facts.append(
                fact(
                    "Employer match formula", f"{share} of what you contribute up to {upto} of pay"
                )
            )
        else:
            facts.append(
                fact(
                    "Employer match formula, next tier",
                    f"{share} of what you contribute from {previous} to {upto} of pay",
                )
            )
        previous = upto
    return facts


def _ordered(citations: Sequence[Citation], first: Sequence[str]) -> list[Citation]:
    """The result's own keys first, in its order, then the rest by key."""
    rank = {key: index for index, key in enumerate(first)}
    return sorted(citations, key=lambda c: (rank.get(c.key, len(rank)), c.key))


def explain_context(
    calculator: str,
    inputs: Mapping[str, Any],
    result: Mapping[str, Any],
    citations: Sequence[Citation],
    passages: Sequence[BenefitsPassage],
) -> ExplainContext:
    if calculator != CalculatorKind.K401_MATCH:
        raise ValueError(f"no explanation context for calculator {calculator!r} yet")
    data = K401MatchInput.model_validate(inputs)
    computed = K401MatchResult.model_validate(result)
    return ExplainContext(
        calculator=calculator,
        tax_year=data.tax_year,
        facts=_k401_facts(data, computed),
        notes=k401_notes(computed, has_match=bool(data.match_tiers)),
        citations=[
            ExplainCitation(key=c.key, title=c.title, passage=c.passage)
            for c in _ordered(citations, computed.citation_keys)
        ],
        benefits_passages=[passage.text for passage in passages],
    )
