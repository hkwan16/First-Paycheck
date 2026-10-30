"""The plain calculator result, written by code (spec 008 rule 17, spec 012 rule 16,
spec 014 rule 19).

Shown when two drafts fail verification or the model cannot be reached. It
uses only the decision's numbers, so it verifies, and it cites the result's
own citation keys that the seed holds.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from decimal import Decimal
from typing import Any

from calc.health_plans import HealthPlansInput, HealthPlansResult
from calc.k401 import K401MatchInput, K401MatchResult
from calc.pay_stub import StubRate, stub_rate
from calc.w4 import W4Input, W4Result
from llm.schemas import ExplanationDraft, NumberClaim
from verify.format import dollars, percent

__all__ = ["FALLBACK_VERSION", "fallback_draft"]

# Stored as a fallback row's prompt_version: the text comes from this module,
# not a prompt, so a change to it is a new version here. v2 (issue 132): the
# 401(k) text speaks of the rate chosen, states the pay stub's rate, and says
# "already" only when the stub shows the rate chosen.
FALLBACK_VERSION = "fallback/v2"

K401_CONCEPT = "Your employer's 401(k) match and what it costs you to earn all of it."
HEALTH_CONCEPT = "Comparing health plans by what each costs you in a year, not just by the premium."
W4_CONCEPT = (
    "How your Form W-4 entries set the federal income tax taken from each paycheck, and"
    " whether that covers the year's tax."
)


# What the newest pay stub shows against the rate chosen (spec 008 rule 7a),
# and how the full match is put when nothing is missed: as earned only when the
# stub shows the rate chosen. No stub, no stub sentence.
STUB_SENTENCES: dict[StubRate, str | None] = {
    StubRate.NONE: None,
    StubRate.CHOSEN: (
        "Your latest pay stub shows {stub} going to your 401(k), so the rate you chose is in"
        " effect now."
    ),
    StubRate.OTHER: (
        "Your latest pay stub shows {stub} going to your 401(k), so the rate you chose takes"
        " effect once you change your election with your employer."
    ),
}
FULL_MATCH_SENTENCES: dict[StubRate, str] = {
    StubRate.NONE: "That rate earns the full match of {full} a year.",
    StubRate.CHOSEN: "You already earn the full match of {full} a year.",
    StubRate.OTHER: "That rate earns the full match of {full} a year.",
}


def _stub_sentence(case: StubRate, pay_stub_pct: Decimal | None) -> list[str]:
    template = STUB_SENTENCES[case]
    if template is None or pay_stub_pct is None:
        return []
    return [template.format(stub=percent(pay_stub_pct))]


def _k401(
    data: K401MatchInput, result: K401MatchResult, pay_stub_pct: Decimal | None
) -> tuple[str, list[NumberClaim]]:
    rate = percent(data.contribution_pct)
    full = percent(result.full_match_pct)
    yours = dollars(result.employee_annual_cents_current)
    case = stub_rate(data.contribution_pct, pay_stub_pct)
    sentences: list[str] = []
    claims = [NumberClaim(value=yours, label="Your yearly contribution at the rate you chose")]
    if not data.match_tiers:
        sentences.append(
            f"Your plan has no employer match. At the {rate} you chose, you put in {yours} a year."
        )
        sentences += _stub_sentence(case, pay_stub_pct)
    else:
        match_now = dollars(result.employer_match_cents_current)
        match_full = dollars(result.employer_match_cents_full)
        sentences.append(
            f"At the {rate} you chose, you put in {yours} a year and your employer adds"
            f" {match_now}."
        )
        sentences += _stub_sentence(case, pay_stub_pct)
        claims.append(NumberClaim(value=match_full, label="Full employer match per year"))
        if result.missed_cents > 0:
            missed = dollars(result.missed_cents)
            sentences.append(
                f"Contributing {full} of pay earns the full match of {match_full} a year,"
                f" so the rate you chose leaves {missed} a year of match behind."
            )
            claims.append(NumberClaim(value=missed, label="Match you miss per year"))
        else:
            sentences.append(FULL_MATCH_SENTENCES[case].format(full=match_full))
        if result.per_paycheck_cost_delta_cents > 0:
            before = dollars(result.per_paycheck_cost_delta_cents)
            after = dollars(result.per_paycheck_after_tax_cost_cents)
            sentences.append(
                f"Moving to {full} takes {before} more from each paycheck before tax, or about"
                f" {after} after federal income tax at your {percent(result.marginal_rate_used)}"
                " marginal rate."
            )
            claims += [
                NumberClaim(value=before, label="Extra per paycheck before tax"),
                NumberClaim(value=after, label="Extra per paycheck after federal income tax"),
            ]
    sentences.append(
        f"Your {data.tax_year} limit on 401(k) contributions is"
        f" {dollars(result.deferral_limit_cents)}."
    )
    if result.capped:
        sentences.append(
            "Your rate asks for more than that limit, so your contributions stop once you reach"
            " it, and a plan that matches each paycheck may stop matching then too."
        )
    if result.compensation_capped:
        sentences.append(
            "Your salary is above the yearly compensation limit, so the match is figured on pay"
            " up to that limit."
        )
    return " ".join(sentences), claims


def _health(data: HealthPlansInput, result: HealthPlansResult) -> tuple[str, list[NumberClaim]]:
    names = [plan.name for plan in result.plans]
    usage = {
        "low": data.usage_low_cents,
        "medium": data.usage_medium_cents,
        "high": data.usage_high_cents,
    }[data.expected_usage]

    def cost_at_usage(index: int) -> int:
        plan = result.plans[index]
        return {
            "low": plan.low_cost_cents,
            "medium": plan.medium_cost_cents,
            "high": plan.high_cost_cents,
        }[data.expected_usage]

    best = result.recommended_index
    best_cost = dollars(cost_at_usage(best))
    sentences = [
        f"At {data.expected_usage} medical use, about {dollars(usage)} of care a year,"
        f" {names[best]} costs you the least: {best_cost} a year after premiums, your share of"
        " the care, the employer's HSA money and the tax an HSA contribution saves."
    ]
    claims = [NumberClaim(value=best_cost, label=f"{names[best]} yearly cost")]
    selected = result.selected_index
    if selected is not None and selected != best:
        picked = dollars(cost_at_usage(selected))
        sentences.append(f"You picked {names[selected]}, which costs {picked} a year at that use.")
        claims.append(NumberClaim(value=picked, label=f"{names[selected]} yearly cost"))
    for pair in result.pairs:
        if pair.break_even_spends_cents:
            spends = " and ".join(dollars(spend) for spend in pair.break_even_spends_cents)
            sentences.append(
                f"Between {names[pair.plan_a_index]} and {names[pair.plan_b_index]}, the cheaper"
                f" plan changes at {spends} of care a year."
            )
    for plan in result.plans:
        if plan.hsa_eligible and plan.employee_hsa_cents > 0:
            saved = dollars(plan.hsa_tax_savings_cents)
            sentences.append(
                f"With {plan.name}, your HSA contribution of {dollars(plan.employee_hsa_cents)}"
                f" saves {saved} of federal income tax at your"
                f" {percent(result.marginal_rate_used)} rate."
            )
            claims.append(NumberClaim(value=saved, label=f"{plan.name} HSA tax saved"))
    if any(plan.kind == "hdhp" for plan in result.plans):
        sentences.append(
            f"The {data.tax_year} limit on HSA contributions for self-only coverage is"
            f" {dollars(result.hsa_limit_cents)}."
        )
    return " ".join(sentences), claims


def _projection_words(cents: int) -> str:
    """A projected refund (positive) or balance due (negative) in words."""
    if cents > 0:
        return f"a refund of about {dollars(cents)}"
    if cents < 0:
        return f"a balance due of about {dollars(-cents)}"
    return "no refund and nothing to pay"


def _w4(data: W4Input, result: W4Result) -> tuple[str, list[NumberClaim]]:
    per_paycheck = dollars(result.withholding_per_paycheck_cents)
    yearly = dollars(result.annual_withholding_cents)
    tax = dollars(result.projected_tax_after_credits_cents)
    sentences = [
        f"With these Form W-4 entries your employer withholds {per_paycheck} of federal income"
        f" tax from each paycheck, {yearly} over the year.",
    ]
    claims = [
        NumberClaim(value=per_paycheck, label="Withheld per paycheck"),
        NumberClaim(value=tax, label="Projected federal income tax after credits"),
    ]
    tax_sentence = f"Your projected federal income tax for {data.tax_year} is {tax}"
    if data.dependents_credit_cents:
        tax_sentence += f" after {dollars(data.dependents_credit_cents)} of credits"
    if data.other_jobs_wages_cents:
        tax_sentence += (
            f", counting {dollars(data.other_jobs_wages_cents)} of wages from your other job and"
            f" the {dollars(data.other_jobs_withholding_cents)} it withholds"
        )
    refund = result.projected_refund_cents
    if refund > 0:
        sentences.append(f"{tax_sentence}, so you would get a refund of about {dollars(refund)}.")
    elif refund < 0:
        sentences.append(f"{tax_sentence}, so you would owe about {dollars(-refund)}.")
    else:
        sentences.append(f"{tax_sentence}, which matches what is withheld.")
    pretax = []
    if result.k401_annual_cents:
        pretax.append(f"{dollars(result.k401_annual_cents)} of 401(k) contributions")
    if result.health_premium_annual_cents:
        pretax.append(f"{dollars(result.health_premium_annual_cents)} of health premiums")
    if pretax:
        sentences.append(
            f"Your {' and '.join(pretax)} a year come out before tax, which lowers what is"
            " withheld."
        )
    if data.multiple_jobs:
        sentences.append(
            "Step 2 is checked, so the withholding uses half the standard deduction and half of"
            " each tax bracket."
        )
    after = _projection_words(result.suggested_refund_cents)
    extra = dollars(result.suggested_extra_withholding_cents)
    if result.suggestion == "increase_extra_withholding":
        sentences.append(
            f"Entering {extra} a paycheck in Step 4(c) changes the projection to {after}."
        )
        claims.append(NumberClaim(value=extra, label="Suggested Step 4(c)"))
    elif result.suggestion == "decrease_extra_withholding":
        sentences.append(
            f"Lowering Step 4(c) to {extra} a paycheck changes the projection to {after}."
        )
        claims.append(NumberClaim(value=extra, label="Suggested Step 4(c)"))
    elif result.suggestion == "increase_deductions":
        deductions = dollars(result.suggested_deductions_cents)
        lead = (
            f"Lowering Step 4(c) to {extra} a paycheck and entering"
            if result.suggested_extra_withholding_cents != data.extra_withholding_cents
            else "Entering"
        )
        sentences.append(
            f"{lead} {deductions} in Step 4(b) lowers what is withheld and changes the"
            f" projection to {after}; keep your expected deductions as they are when you save it."
        )
        claims.append(NumberClaim(value=deductions, label="Suggested Step 4(b)"))
    if result.k401_capped:
        sentences.append(
            "Your 401(k) rate asks for more than the yearly limit, so only the limit is counted."
        )
    return " ".join(sentences), claims


def fallback_draft(
    calculator: str,
    inputs: Mapping[str, Any],
    result: Mapping[str, Any],
    allowed_citation_keys: Collection[str],
    *,
    pay_stub_pct: Decimal | None = None,
) -> ExplanationDraft:
    """The code-written explanation; ``pay_stub_pct`` (spec 008 rule 7a) is the
    newest stub's 401(k) rate, None without a stub, read for ``k401_match`` only."""
    if calculator == "w4":
        entries = W4Input.model_validate(inputs)
        projected = W4Result.model_validate(result)
        text, claims = _w4(entries, projected)
        return ExplanationDraft(
            concept=W4_CONCEPT,
            text=text,
            numbers=claims,
            what_ifs=[],
            citation_keys=[key for key in projected.citation_keys if key in allowed_citation_keys],
        )
    if calculator == "health_plans":
        plans = HealthPlansInput.model_validate(inputs)
        compared = HealthPlansResult.model_validate(result)
        text, claims = _health(plans, compared)
        return ExplanationDraft(
            concept=HEALTH_CONCEPT,
            text=text,
            numbers=claims,
            what_ifs=[],
            citation_keys=[key for key in compared.citation_keys if key in allowed_citation_keys],
        )
    if calculator != "k401_match":
        raise ValueError(f"no fallback text for calculator {calculator!r} yet")
    data = K401MatchInput.model_validate(inputs)
    computed = K401MatchResult.model_validate(result)
    text, claims = _k401(data, computed, pay_stub_pct)
    return ExplanationDraft(
        concept=K401_CONCEPT,
        text=text,
        numbers=claims,
        what_ifs=[],
        citation_keys=[key for key in computed.citation_keys if key in allowed_citation_keys],
    )
