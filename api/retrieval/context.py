"""What the explain prompt is given about a decision (spec 008 rules 7 and 7a).

Facts are the decision's own numbers, formatted the way the verifier reads
them back; every fact passes ``verify_explanation`` by construction (a test
checks this on every spec 006 and spec 012 example). Labels carry no numbers
of their own; a health plan's name may, and ``name_numbers`` lets the verifier
accept them (spec 012 rule 16). A 401(k) decision also gets the rate the
newest confirmed pay stub shows, which is not part of the decision: the
decision holds the rate chosen, the stub what goes in now (issue 132).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from calc.health_plans import HealthPlansInput, HealthPlansResult
from calc.k401 import K401MatchInput, K401MatchResult
from calc.pay_stub import StubRate, stub_rate
from calc.w4 import W4Input, W4Result
from db.enums import CalculatorKind
from llm.schemas import ExplainCitation, ExplainContext, ExplainFact, ExplanationDraft
from retrieval.benefits_search import BenefitsPassage
from retrieval.citations import Citation
from verify.allowed import AllowedNumbers
from verify.fallback import fallback_draft
from verify.format import dollars, net_cost, percent
from verify.numbers import extract_numbers

__all__ = [
    "BENEFITS_PASSAGES",
    "BENEFITS_QUERIES",
    "ExplainSetup",
    "context_digest",
    "explain_context",
    "explain_setup",
    "health_notes",
    "k401_notes",
    "name_numbers",
    "pay_stub_numbers",
    "w4_notes",
]

# The full-text query run over the user's benefits text for each calculator
# that can be explained. A calculator missing here has no explanation yet
# (emergency_fund: spec 011, out of scope).
BENEFITS_QUERIES: dict[CalculatorKind, str] = {
    CalculatorKind.K401_MATCH: "401(k) retirement match vesting",
    CalculatorKind.HEALTH_PLANS: "health plan deductible coinsurance out-of-pocket premium HSA",
    CalculatorKind.W4: "pre-tax premium payroll deduction 401(k)",
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
# Spec 008 rule 7a: what the newest confirmed pay stub says about the chosen
# rate. No digits, so a draft that repeats a note adds no number.
STUB_SAME_NOTE = (
    "The latest pay stub shows the rate chosen, so it is already in effect: it is what goes"
    " to the 401(k) from each paycheck now."
)
STUB_DIFFERS_NOTE = (
    "The latest pay stub shows a different rate from the one chosen. The pay stub shows what"
    " goes to the 401(k) now; the rate chosen takes effect only once the election is changed"
    " with the employer, so it is not in effect yet."
)
NO_STUB_NOTE = (
    "No confirmed pay stub shows what goes to the 401(k) now, so the rate chosen may not be"
    " in effect yet."
)


STUB_NOTES: dict[StubRate, str] = {
    StubRate.NONE: NO_STUB_NOTE,
    StubRate.CHOSEN: STUB_SAME_NOTE,
    StubRate.OTHER: STUB_DIFFERS_NOTE,
}


def k401_notes(result: K401MatchResult, *, has_match: bool) -> list[str]:
    notes = []
    if not has_match:
        notes.append(NO_MATCH_NOTE)
    if result.capped:
        notes.append(CAPPED_NOTE)
    if result.compensation_capped:
        notes.append(COMPENSATION_NOTE)
    return notes


def pay_stub_numbers(calculator: str, pay_stub_pct: Decimal | None) -> dict[str, str]:
    """The pay stub's rate keyed for ``AllowedNumbers.from_decision`` (spec 008
    rule 12): a ``_pct`` key, so it reads as a percentage."""
    if calculator != CalculatorKind.K401_MATCH or pay_stub_pct is None:
        return {}
    return {"pay_stub_contribution_pct": str(pay_stub_pct)}


def _k401_facts(
    data: K401MatchInput, result: K401MatchResult, pay_stub_pct: Decimal | None
) -> list[ExplainFact]:
    def fact(label: str, value: str) -> ExplainFact:
        return ExplainFact(label=label, value=value)

    facts = [fact("Contribution rate you chose", percent(data.contribution_pct))]
    if pay_stub_pct is not None:
        facts.append(
            fact("401(k) contribution rate your latest pay stub shows", percent(pay_stub_pct))
        )
    if data.match_tiers:
        facts += [
            fact("Contribution rate that earns the full match", percent(result.full_match_pct)),
            fact(
                "Employer match per year at the rate you chose",
                dollars(result.employer_match_cents_current),
            ),
            fact(
                "Employer match per year at the full-match rate",
                dollars(result.employer_match_cents_full),
            ),
            fact("Match you miss per year at the rate you chose", dollars(result.missed_cents)),
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
        fact(
            "Your yearly contribution at the rate you chose",
            dollars(result.employee_annual_cents_current),
        ),
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
    "A cost written as an amount ahead means the employer's HSA money and the tax saved are"
    " more than the premiums and care, so the plan leaves the person that much ahead for the"
    " year. Write it the same way, as the amount followed by the word ahead, never with a minus"
    " sign."
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
            fact(f"{name}: cost per year at low medical use", net_cost(cost.low_cost_cents)),
            fact(f"{name}: cost per year at medium medical use", net_cost(cost.medium_cost_cents)),
            fact(f"{name}: cost per year at high medical use", net_cost(cost.high_cost_cents)),
            fact(
                f"{name}: cost per year at the out-of-pocket maximum",
                net_cost(cost.worst_case_cents),
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


REFUND_NOTE = "The projection is a refund: more is withheld than the year's tax."
BALANCE_DUE_NOTE = "The projection is a balance due: less is withheld than the year's tax."
EVEN_NOTE = "What is withheld matches the projected tax for the year."
STEP2_NOTE = (
    "Step 2 is checked, so this job's withholding uses half the standard deduction and half"
    " of each tax bracket, on the assumption that the other job pays about the same."
)
STEP2_ALONE_NOTE = (
    "Step 2 is checked but no other job's wages were given, so this job withholds more than"
    " it needs; leaving Step 2 unchecked is the simpler fix."
)
RAISE_EXTRA_NOTE = (
    "The suggestion adds whole dollars of extra withholding in Step 4(c) to each paycheck,"
    " which brings the projection close to zero."
)
LOWER_EXTRA_NOTE = (
    "The suggestion lowers the extra withholding in Step 4(c), which brings the projection"
    " closer to zero."
)
ADD_DEDUCTIONS_NOTE = (
    "The suggested Step 4(b) amount is more than the deductions expected; it only lowers"
    " withholding, so the expected deductions stay as they are when it is saved."
)
CREDITS_EXCEED_NOTE = (
    "The credits are more than the tax, so nothing is withheld for income tax; the part of"
    " the credits left over is not counted as a refund here."
)
K401_CAPPED_NOTE = (
    "The 401(k) rate asks for more than the yearly contribution limit, so only the limit is"
    " counted as pre-tax pay."
)


def w4_notes(data: W4Input, result: W4Result) -> list[str]:
    """The plain-words situation: refund or balance due, Step 2, the suggestion and
    the caveats. No digits, so a draft that repeats a note adds no number."""
    if result.projected_refund_cents > 0:
        notes = [REFUND_NOTE]
    elif result.projected_refund_cents < 0:
        notes = [BALANCE_DUE_NOTE]
    else:
        notes = [EVEN_NOTE]
    if data.multiple_jobs:
        notes.append(STEP2_NOTE if data.other_jobs_wages_cents > 0 else STEP2_ALONE_NOTE)
    notes += {
        "increase_extra_withholding": [RAISE_EXTRA_NOTE],
        "decrease_extra_withholding": [LOWER_EXTRA_NOTE],
        "increase_deductions": [ADD_DEDUCTIONS_NOTE],
        "none": [],
    }[result.suggestion]
    if 0 < result.projected_tax_cents <= data.dependents_credit_cents:
        notes.append(CREDITS_EXCEED_NOTE)
    if result.k401_capped:
        notes.append(K401_CAPPED_NOTE)
    return notes


def _refund_fact(label: str, cents: int) -> ExplainFact:
    """A refund as itself, a balance due by its size under its own label."""
    if cents < 0:
        return ExplainFact(label=label.replace("refund", "balance due"), value=dollars(-cents))
    return ExplainFact(label=label, value=dollars(cents))


def _w4_facts(data: W4Input, result: W4Result) -> list[ExplainFact]:
    def fact(label: str, cents: int) -> ExplainFact:
        return ExplainFact(label=label, value=dollars(cents))

    facts = [
        fact("Federal income tax withheld per paycheck", result.withholding_per_paycheck_cents),
        fact("Federal income tax withheld per year", result.annual_withholding_cents),
        fact(
            "Projected federal income tax for the year before credits", result.projected_tax_cents
        ),
        fact(
            "Projected federal income tax for the year after credits",
            result.projected_tax_after_credits_cents,
        ),
        _refund_fact("Projected refund", result.projected_refund_cents),
        fact("Projected taxable income", result.projected_taxable_income_cents),
        fact(
            "Wages subject to income tax withholding per paycheck",
            result.taxable_wages_per_paycheck_cents,
        ),
        fact("Yearly wage amount the withholding table uses", result.adjusted_annual_wage_cents),
        ExplainFact(label="Withholding table rate", value=percent(result.withholding_rate_pct)),
    ]
    if result.k401_annual_cents:
        facts += [
            ExplainFact(
                label="401(k) contribution rate", value=percent(data.k401_contribution_pct)
            ),
            fact("401(k) contributions per year, before tax", result.k401_annual_cents),
        ]
    if result.health_premium_annual_cents:
        facts.append(
            fact("Health premiums per year, before tax", result.health_premium_annual_cents)
        )
    entries = (
        ("Step 3 credits per year", data.dependents_credit_cents),
        ("Step 4(a) other income per year", data.other_income_cents),
        ("Step 4(b) deductions per year", data.deductions_cents),
        ("Step 4(c) extra withholding per paycheck", data.extra_withholding_cents),
        ("Other jobs' wages per year", data.other_jobs_wages_cents),
        ("Other jobs' federal income tax withheld per year", data.other_jobs_withholding_cents),
    )
    facts += [fact(label, cents) for label, cents in entries if cents]
    if data.expected_deductions_cents is not None:
        facts.append(
            fact(
                "Deductions expected beyond the standard deduction", data.expected_deductions_cents
            )
        )
    if result.suggestion != "none":
        if result.suggested_extra_withholding_cents != data.extra_withholding_cents:
            facts.append(
                fact(
                    "Suggested Step 4(c) extra withholding per paycheck",
                    result.suggested_extra_withholding_cents,
                )
            )
        if result.suggested_deductions_cents != data.deductions_cents:
            facts.append(fact("Suggested Step 4(b) deductions", result.suggested_deductions_cents))
        facts.append(
            _refund_fact(
                "Projected refund with the suggested entries", result.suggested_refund_cents
            )
        )
    facts += [
        fact("Salary", data.salary_cents),
        ExplainFact(label="Paychecks per year", value=str(data.pay_periods_per_year)),
        ExplainFact(label="Tax year", value=str(data.tax_year)),
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
    *,
    pay_stub_pct: Decimal | None = None,
) -> ExplainContext:
    """``pay_stub_pct`` is the newest confirmed stub's 401(k) rate (spec 008 rule
    7a), None without a stub; only a ``k401_match`` decision uses it."""
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
    if calculator == CalculatorKind.W4:
        entries = W4Input.model_validate(inputs)
        projected = W4Result.model_validate(result)
        return ExplainContext(
            calculator=calculator,
            tax_year=entries.tax_year,
            facts=_w4_facts(entries, projected),
            notes=w4_notes(entries, projected),
            citations=[
                ExplainCitation(key=c.key, title=c.title, passage=c.passage)
                for c in _ordered(citations, projected.citation_keys)
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
        facts=_k401_facts(data, computed, pay_stub_pct),
        notes=[
            STUB_NOTES[stub_rate(data.contribution_pct, pay_stub_pct)],
            *k401_notes(computed, has_match=bool(data.match_tiers)),
        ],
        citations=[
            ExplainCitation(key=c.key, title=c.title, passage=c.passage)
            for c in _ordered(citations, computed.citation_keys)
        ],
        benefits_passages=[passage.text for passage in passages],
    )


def context_digest(context: ExplainContext) -> str:
    """The SHA-256 (lowercase hex) of the context as canonical JSON (spec 008
    rule 19a): sorted keys, no whitespace, UTF-8. The context holds every fact,
    note and passage a run is written from and checked against, so two runs
    with the same digest were given the same things."""
    canonical = json.dumps(
        context.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ExplainSetup:
    """Everything a run of ``verify.flow.run_explain`` takes besides the model,
    built once from the same pay stub rate for ``POST /explain`` and the evals."""

    context: ExplainContext
    allowed_numbers: AllowedNumbers
    citation_keys: frozenset[str]
    fallback: ExplanationDraft

    @property
    def digest(self) -> str:
        """What every row of a run from this setup stores (rule 19a)."""
        return context_digest(self.context)


def explain_setup(
    calculator: str,
    inputs: Mapping[str, Any],
    result: Mapping[str, Any],
    citations: Sequence[Citation],
    passages: Sequence[BenefitsPassage],
    *,
    pay_stub_pct: Decimal | None,
) -> ExplainSetup:
    """The context, the numbers the verifier allows, the citation keys and the
    fallback for one decision (spec 008 rules 7-17)."""
    keys = frozenset(citation.key for citation in citations)
    return ExplainSetup(
        context=explain_context(
            calculator, inputs, result, citations, passages, pay_stub_pct=pay_stub_pct
        ),
        allowed_numbers=AllowedNumbers.from_decision(
            inputs,
            result,
            name_numbers(calculator, inputs),
            pay_stub_numbers(calculator, pay_stub_pct),
        ),
        citation_keys=keys,
        fallback=fallback_draft(calculator, inputs, result, keys, pay_stub_pct=pay_stub_pct),
    )
