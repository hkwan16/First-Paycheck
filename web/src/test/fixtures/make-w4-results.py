"""Write w4-results.json: W-4 projections computed by the API's own calculator
(api/calc/w4.py), for the MSW handler of POST /calc/w4 and the sample
screens. The web app never computes a result, and neither do its tests: they
answer from this table.

Cases: J. Rivera ($65,000.00, semi-monthly, single, 2026, 30 by the end of
the year, whose Oct 15 stub withholds $297.76 a paycheck) with the sample's
saved 401(k) decision (4%) and health plan decision (the Gold PPO, $62.50 a
paycheck), with either, with neither, with no birth year, with no stub
withholding to compare (a stub for another pay schedule), and with a later
stub that withholds what the entries do; each filing status; Step 3 credits of $2,200.00; Step
4(c) of $100.00 a paycheck (the suggestion lowers it); a second job paying
$20,000.00 that withholds $390.00 (the suggestion raises Step 4(c)); and Step
2 checked with no other job (the suggestion adds to Step 4(b)). Every case
with a suggestion is followed by the case the card sends once the person
applies it: the suggested Step 4(b) and 4(c) entries copied into the inputs
and, for a Step 4(b) suggestion, the Step 4(b) entry they had kept as the
expected deductions (spec 014 rule 13). Then issue 153's user (spec 014
example 11: stub-01's $3,653.85 biweekly, 9,500,010 cents a year, single, 24
by the end of 2026, withholding $272.44 a paycheck) with the 401(k) at 5% and
a $4.00 health premium, and with a stub that withholds nothing.

Run from the repository root, then format:
    uv run --project api python web/src/test/fixtures/make-w4-results.py
    (cd web && pnpm exec prettier --write src/test/fixtures/w4-results.json)
"""

import json
from pathlib import Path

from calc.w4 import W4Input, w4

# Every field, so each case is the body the card sends.
SAMPLE = {
    "salary_cents": 6_500_000,
    "pay_periods_per_year": 24,
    "filing_status": "single",
    "tax_year": 2026,
    "k401_contribution_pct": "4.00",
    "age": 30,
    "health_premium_per_paycheck_cents": 6_250,
    "multiple_jobs": False,
    "dependents_credit_cents": 0,
    "other_income_cents": 0,
    "deductions_cents": 0,
    "extra_withholding_cents": 0,
    "expected_deductions_cents": None,
    "other_jobs_wages_cents": 0,
    "other_jobs_withholding_cents": 0,
    # The sample stub's federal withholding (spec 014 rule 10a).
    "current_withholding_per_paycheck_cents": 29_776,
}

STUB_01 = {
    **SAMPLE,
    "salary_cents": 9_500_010,
    "pay_periods_per_year": 26,
    "k401_contribution_pct": "5.00",
    "age": 24,
    "health_premium_per_paycheck_cents": 400,
    "current_withholding_per_paycheck_cents": 27_244,
}


def case(raw: dict[str, object]) -> dict[str, object]:
    inputs = W4Input.model_validate(raw)
    return {
        "inputs": inputs.model_dump(mode="json"),
        "result": w4(inputs).model_dump(mode="json"),
    }


def applied(raw: dict[str, object]) -> dict[str, object] | None:
    """The inputs once the suggestion is applied, or None when there is none."""
    result = w4(W4Input.model_validate(raw))
    if result.suggestion == "none":
        return None
    expected = raw["expected_deductions_cents"]
    if result.suggestion == "increase_deductions" and expected is None:
        expected = raw["deductions_cents"]
    return {
        **raw,
        "extra_withholding_cents": result.suggested_extra_withholding_cents,
        "deductions_cents": result.suggested_deductions_cents,
        "expected_deductions_cents": expected,
    }


raws: list[dict[str, object]] = [
    SAMPLE,
    {**SAMPLE, "k401_contribution_pct": "0.00", "health_premium_per_paycheck_cents": 0},
    {**SAMPLE, "k401_contribution_pct": "0.00"},
    {**SAMPLE, "health_premium_per_paycheck_cents": 0},
    {**SAMPLE, "age": None},
    {**SAMPLE, "current_withholding_per_paycheck_cents": None},
    # The next stub, once payroll applies the saved W-4: it withholds the entries' $213.67.
    {**SAMPLE, "current_withholding_per_paycheck_cents": 21_367},
    {**SAMPLE, "filing_status": "married_filing_jointly"},
    {**SAMPLE, "filing_status": "head_of_household"},
    {**SAMPLE, "dependents_credit_cents": 220_000},
    {**SAMPLE, "extra_withholding_cents": 10_000},
    {**SAMPLE, "other_jobs_wages_cents": 2_000_000, "other_jobs_withholding_cents": 39_000},
    {**SAMPLE, "multiple_jobs": True},
]
raws += [after for raw in list(raws) if (after := applied(raw)) is not None]
raws += [
    STUB_01,
    {**STUB_01, "current_withholding_per_paycheck_cents": 0},
]

cases: list[dict[str, object]] = []
for raw in raws:
    made = case(raw)
    if all(made["inputs"] != seen["inputs"] for seen in cases):
        cases.append(made)

Path(__file__).with_name("w4-results.json").write_text(json.dumps(cases, indent=2) + "\n")
