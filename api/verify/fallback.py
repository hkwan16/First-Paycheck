"""The plain calculator result, written by code (spec 008 rule 17).

Shown when two drafts fail verification or the model cannot be reached. It
uses only the decision's numbers, so it verifies, and it cites the result's
own citation keys that the seed holds.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from typing import Any

from calc.k401 import K401MatchInput, K401MatchResult
from llm.schemas import ExplanationDraft, NumberClaim
from verify.format import dollars, percent

__all__ = ["fallback_draft"]

K401_CONCEPT = "Your employer's 401(k) match and what it costs you to earn all of it."


def _k401(data: K401MatchInput, result: K401MatchResult) -> tuple[str, list[NumberClaim]]:
    rate = percent(data.contribution_pct)
    full = percent(result.full_match_pct)
    yours = dollars(result.employee_annual_cents_current)
    sentences: list[str] = []
    claims = [NumberClaim(value=yours, label="Your yearly contribution")]
    if not data.match_tiers:
        sentences.append(
            f"Your plan has no employer match. At {rate} of pay you put in {yours} a year."
        )
    else:
        match_now = dollars(result.employer_match_cents_current)
        match_full = dollars(result.employer_match_cents_full)
        sentences.append(
            f"At {rate} of pay you put in {yours} a year and your employer adds {match_now}."
        )
        claims.append(NumberClaim(value=match_full, label="Full employer match per year"))
        if result.missed_cents > 0:
            missed = dollars(result.missed_cents)
            sentences.append(
                f"Contributing {full} of pay earns the full match of {match_full} a year,"
                f" so you are missing {missed} a year."
            )
            claims.append(NumberClaim(value=missed, label="Match you miss per year"))
        else:
            sentences.append(f"You already earn the full match of {match_full} a year.")
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


def fallback_draft(
    calculator: str,
    inputs: Mapping[str, Any],
    result: Mapping[str, Any],
    allowed_citation_keys: Collection[str],
) -> ExplanationDraft:
    if calculator != "k401_match":
        raise ValueError(f"no fallback text for calculator {calculator!r} yet")
    data = K401MatchInput.model_validate(inputs)
    computed = K401MatchResult.model_validate(result)
    text, claims = _k401(data, computed)
    return ExplanationDraft(
        concept=K401_CONCEPT,
        text=text,
        numbers=claims,
        what_ifs=[],
        citation_keys=[key for key in computed.citation_keys if key in allowed_citation_keys],
    )
