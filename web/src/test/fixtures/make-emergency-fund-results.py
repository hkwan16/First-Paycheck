"""Write emergency-fund-results.json: emergency fund results computed by the
API's own calculator (api/calc/emergency_fund.py), for the MSW handler of
POST /calc/emergency-fund and the sample screens. The web app never computes
a result, and neither do its tests: they answer from this table.

Cases: the mockup's sample (J. Rivera, essentials of $1,823.25 a month from
the sample spending summary, $2,140.00 in Chase Savings, semi-monthly pay) at
every target from 3 to 12 months and four monthly contributions ($0, $10,
$300 and $500), then three single cases a test types: $2,000.00 of
essentials, a $0 balance, and a $6,000.00 balance that already funds three
months.

Run from the repository root, then format:
    uv run --project api python web/src/test/fixtures/make-emergency-fund-results.py
    (cd web && pnpm exec prettier --write src/test/fixtures/emergency-fund-results.json)
"""

import json
from pathlib import Path

from calc.emergency_fund import EmergencyFundInput, emergency_fund

SAMPLE = {
    "monthly_essentials_cents": 182_325,
    "current_balance_cents": 214_000,
    "pay_periods_per_year": 24,
}
CONTRIBUTIONS = (0, 1_000, 30_000, 50_000)


def case(raw: dict[str, object]) -> dict[str, object]:
    inputs = EmergencyFundInput.model_validate(raw)
    return {
        "inputs": inputs.model_dump(mode="json"),
        "result": emergency_fund(inputs).model_dump(mode="json"),
    }


cases = [
    case({**SAMPLE, "target_months": months, "monthly_contribution_cents": contribution})
    for months in range(3, 13)
    for contribution in CONTRIBUTIONS
]
single = {**SAMPLE, "target_months": 3, "monthly_contribution_cents": 30_000}
cases += [
    case({**single, "monthly_essentials_cents": 200_000}),
    case({**single, "current_balance_cents": 0}),
    case({**single, "current_balance_cents": 600_000}),
]
Path(__file__).with_name("emergency-fund-results.json").write_text(
    json.dumps(cases, indent=2) + "\n"
)
