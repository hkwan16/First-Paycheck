"""Write k401-results.json: 401(k) match results computed by the API's own
calculator (api/calc/k401.py), for the MSW handler of POST /calc/401k-match
and the sample screens. The web app never computes a result, and neither do
its tests: they answer from this table.

Cases: the mockup's sample (J. Rivera, $65,000.00, semi-monthly, Acme matches
100% of the first 4%, single, age 30) at every slider stop from 0% to 15%,
spec 006 example 9, where the 402(g) and compensation limits both bind, and
the same new user at 0% on the salary the Acme stub implies (spec 005 rule
24a: 270,833 x 24 = 6,499,992 cents), saved without retyping it.

Run from api/, then format:
    uv run python ../web/src/test/fixtures/make-k401-results.py
    (cd ../web && pnpm exec prettier --write src/test/fixtures/k401-results.json)
"""

import json
from pathlib import Path

from calc.k401 import K401MatchInput, k401_match

SAMPLE = {
    "salary_cents": 6_500_000,
    "pay_periods_per_year": 24,
    "match_tiers": [{"employee_pct_upto": "4.00", "employer_pct": "100.00"}],
    "tax_year": 2026,
    "filing_status": "single",
    "age": 30,
}

CAPPED = {
    "salary_cents": 50_000_000,
    "pay_periods_per_year": 26,
    "match_tiers": [
        {"employee_pct_upto": "3.00", "employer_pct": "100.00"},
        {"employee_pct_upto": "5.00", "employer_pct": "50.00"},
    ],
    "contribution_pct": "6.00",
    "tax_year": 2026,
    "filing_status": "single",
    "age": 30,
}


def case(raw: dict[str, object]) -> dict[str, object]:
    inputs = K401MatchInput.model_validate(raw)
    return {
        "inputs": inputs.model_dump(mode="json"),
        "result": k401_match(inputs).model_dump(mode="json"),
    }


cases = [case({**SAMPLE, "contribution_pct": f"{pct}.00"}) for pct in range(16)]
cases.append(case(CAPPED))
cases.append(case({**SAMPLE, "salary_cents": 6_499_992, "contribution_pct": "0.00"}))
Path(__file__).with_name("k401-results.json").write_text(json.dumps(cases, indent=2) + "\n")
