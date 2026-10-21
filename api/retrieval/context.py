"""What the explain prompt is given about a decision (spec 008 rule 7).

Facts are the decision's own numbers, formatted the way the verifier reads
them back; every fact passes ``verify_explanation`` by construction (a test
checks this on every spec 006 and spec 012 example). Labels carry no numbers
of their own; a health plan's name may, and ``name_numbers`` lets the verifier
accept them (spec 012 rule 16).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from calc.health_plans import HealthPlansInput, HealthPlansResult
from calc.k401 import K401MatchInput, K401MatchResult
from db.enums import CalculatorKind
from llm.schemas import ExplainCitation, ExplainContext, ExplainFact
from retrieval.benefits_search import BenefitsPassage
from retrieval.citations import Citation
from verify.format import dollars, percent
from verify.numbers import extract_numbers

__all__ = [
    "BENEFITS_PASSAGES",
    "BENEFITS_QUERIES",
    "explain_context",
    "health_notes",
    "k401_notes",
    "name_numbers",
]

# The full-text query run over the user's benefits text for each calculator
# that can be explained. A calculator missing here has no explanation yet
# (emergency_fund: spec 011, out of scope).
BENEFITS_QUERIES: dict[CalculatorKind, str] = {
    CalculatorKind.K401_MATCH: "401(k) retirement match vesting",
    CalculatorKind.HEALTH_PLANS: "health plan deductible coinsurance out-of-pocket premium HSA",
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


HSA_CAPPED_NOTE = (
    "The HSA contribution asked for is more than the yearly limit leaves room for after the"
    " employer's contribution, so only the part under the limit is counted."
)
BELOW_HDHP_NOTE = (
    "A plan labeled high-deductible misses this year's minimum deductible or maximum"
    " out-of-pocket for an HSA, so no HSA contribution is counted for it."
)
NEGATIVE_COST_NOTE = (
    "A negative yearly cost means the employer's HSA money and the tax saved are more than"
    " the premiums and care."
)


def health_notes(data: HealthPlansInput, result: HealthPlansResult) -> list[str]:
    """The plain-words situation: which plan is cheapest, which one the user
    picked, pairs that never trade places, and the HSA caveats. Facts carry
    only numbers, so a draft that repeats a fact's value always shows one."""
    names = [plan.name for plan in result.plans]
    notes = [
        f"Expected medical use is {data.expected_usage}; at that use"
        f" {names[result.recommended_index]} costs the least.",
    ]
    if result.selected_index is not None:
        notes.append(f"The plan picked is {names[result.selected_index]}.")
    for pair in result.pairs:
        if not pair.break_even_spends_cents and pair.cheaper_at_zero_index is not None:
            other = (
                pair.plan_b_index
                if pair.cheaper_at_zero_index == pair.plan_a_index
                else pair.plan_a_index
            )
            notes.append(
                f"{names[pair.cheaper_at_zero_index]} costs less than {names[other]} at every"
                " level of medical spending."
            )
    if any(plan.hsa_capped for plan in result.plans):
        notes.append(HSA_CAPPED_NOTE)
    if any(plan.kind == "hdhp" and not plan.hsa_eligible for plan in result.plans):
        notes.append(BELOW_HDHP_NOTE)
    if any(plan.low_cost_cents < 0 for plan in result.plans):
        notes.append(NEGATIVE_COST_NOTE)
    return notes


def _health_facts(data: HealthPlansInput, result: HealthPlansResult) -> list[ExplainFact]:
    def fact(label: str, value: str) -> ExplainFact:
        return ExplainFact(label=label, value=value)

    usage = {
        "low": data.usage_low_cents,
        "medium": data.usage_medium_cents,
        "high": data.usage_high_cents,
    }
    names = [plan.name for plan in result.plans]
    facts = [fact("Federal marginal tax rate used", percent(result.marginal_rate_used))]
    facts += [
        fact(f"Medical spending per year at {level} use", dollars(cents))
        for level, cents in usage.items()
    ]
    facts += [
        fact("Yearly HSA contribution limit, self-only", dollars(result.hsa_limit_cents)),
        fact("Lowest deductible an HSA plan may have", dollars(result.hdhp_min_deductible_cents)),
        fact(
            "Highest out-of-pocket maximum an HSA plan may have", dollars(result.hdhp_max_oop_cents)
        ),
    ]
    for option, cost in zip(data.plans, result.plans, strict=True):
        name = option.name
        facts += [
            fact(f"{name}: premiums per year", dollars(cost.annual_premium_cents)),
            fact(f"{name}: deductible", dollars(option.deductible_cents)),
            fact(f"{name}: your share after the deductible", percent(option.coinsurance_pct)),
            fact(f"{name}: out-of-pocket maximum", dollars(option.oop_max_cents)),
        ]
        if cost.employer_hsa_cents:
            facts.append(
                fact(f"{name}: employer HSA contribution", dollars(cost.employer_hsa_cents))
            )
        if cost.hsa_eligible:
            facts += [
                fact(f"{name}: your HSA contribution counted", dollars(cost.employee_hsa_cents)),
                fact(
                    f"{name}: federal tax your HSA contribution saves",
                    dollars(cost.hsa_tax_savings_cents),
                ),
            ]
        facts += [
            fact(f"{name}: cost per year at low medical use", dollars(cost.low_cost_cents)),
            fact(f"{name}: cost per year at medium medical use", dollars(cost.medium_cost_cents)),
            fact(f"{name}: cost per year at high medical use", dollars(cost.high_cost_cents)),
            fact(
                f"{name}: cost per year at the out-of-pocket maximum",
                dollars(cost.worst_case_cents),
            ),
        ]
    for pair in result.pairs:
        spends = pair.break_even_spends_cents
        if spends:
            label = (
                f"{names[pair.plan_a_index]} versus {names[pair.plan_b_index]}: yearly medical"
                " spending where the cheaper plan changes"
            )
            facts.append(fact(label, ", ".join(dollars(spend) for spend in spends)))
    facts += [
        fact("Salary", dollars(data.salary_cents)),
        fact("Paychecks per year", str(data.pay_periods_per_year)),
        fact("Tax year", str(data.tax_year)),
    ]
    return facts


def name_numbers(calculator: str, inputs: Mapping[str, Any]) -> dict[str, list[Any]]:
    """The numbers inside health plan names ("Gold PPO 2", "Silver $500"), keyed so
    ``AllowedNumbers.from_decision`` reads them as plain, money and percent values.
    A plan's name is the user's confirmed text, not a figure the model made up."""
    if calculator != CalculatorKind.HEALTH_PLANS:
        return {}
    plain: list[int] = []
    cents: list[int] = []
    percents: list[str] = []
    for plan in inputs.get("plans", []):
        for token in extract_numbers(str(plan.get("name", ""))):
            value = abs(token.value)
            if token.kind == "money":
                cents.append(int(value * 100))
            elif token.kind == "percent":
                percents.append(str(value))
            elif value == value.to_integral_value():
                plain.append(int(value))
    extras: dict[str, list[Any]] = {}
    for key, values in (
        ("plan_name_numbers", plain),
        ("plan_name_cents", cents),
        ("plan_name_pct", percents),
    ):
        if values:
            extras[key] = values
    return extras


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
    if calculator == CalculatorKind.HEALTH_PLANS:
        plans = HealthPlansInput.model_validate(inputs)
        compared = HealthPlansResult.model_validate(result)
        return ExplainContext(
            calculator=calculator,
            tax_year=plans.tax_year,
            facts=_health_facts(plans, compared),
            notes=health_notes(plans, compared),
            citations=[
                ExplainCitation(key=c.key, title=c.title, passage=c.passage)
                for c in _ordered(citations, compared.citation_keys)
            ],
            benefits_passages=[passage.text for passage in passages],
        )
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
