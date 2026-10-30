"""Write health-plans-results.json: health plan comparisons computed by the
API's own calculator (api/calc/health_plans.py), for the MSW handler of
POST /calc/health-plans and the sample screens. The web app never computes a
result, and neither do its tests: they answer from this table.

Cases: the sample benefits summary's three Acme plans (the mockup's Bronze
HSA high-deductible plan and Gold PPO, and a Saver HDHP whose $1,000.00 of
employer HSA money is more than its premiums and low use's care, so it comes
out ahead at low use, spec 012 rule 17) for J. Rivera ($65,000.00,
semi-monthly, single, 2026) at every expected usage, with no plan chosen or
any one, contributing $0 or $1,000.00 to the HSA, with the summary's
enrollment deadline; the same plans at medium usage with no deadline; one
plan typed by hand; a plan labeled HDHP below the 2026 minimum deductible;
and an HSA contribution over the limit.

Run from the repository root, then format:
    uv run --project api python web/src/test/fixtures/make-health-plans-results.py
    (cd web && pnpm exec prettier --write src/test/fixtures/health-plans-results.json)
"""

import json
from pathlib import Path

from calc.health_plans import HealthPlansInput, health_plans

BRONZE = {
    "name": "Bronze HSA",
    "kind": "hdhp",
    "premium_per_period_cents": 3_125,
    "deductible_cents": 180_000,
    "coinsurance_pct": "20.00",
    "oop_max_cents": 350_000,
    "employer_hsa_cents": 60_000,
}
GOLD = {
    "name": "Gold PPO",
    "kind": "ppo",
    "premium_per_period_cents": 6_250,
    "deductible_cents": 25_000,
    "coinsurance_pct": "10.00",
    "oop_max_cents": 300_000,
    "employer_hsa_cents": 0,
}
SAVER = {
    "name": "Saver HDHP",
    "kind": "hdhp",
    "premium_per_period_cents": 1_000,
    "deductible_cents": 320_000,
    "coinsurance_pct": "20.00",
    "oop_max_cents": 650_000,
    "employer_hsa_cents": 100_000,
}
SILVER = {
    "name": "Silver HMO",
    "kind": "hmo",
    "premium_per_period_cents": 4_000,
    "deductible_cents": 100_000,
    "coinsurance_pct": "0.00",
    "oop_max_cents": 250_000,
    "employer_hsa_cents": 0,
}
DEADLINE = "2026-11-14"
SAMPLE = {
    "plans": [BRONZE, GOLD, SAVER],
    "pay_periods_per_year": 24,
    "salary_cents": 6_500_000,
    "filing_status": "single",
    "tax_year": 2026,
    "employee_hsa_cents": 0,
    "expected_usage": "medium",
    "selected_plan_index": None,
    "enrollment_deadline": DEADLINE,
}


def case(raw: dict[str, object]) -> dict[str, object]:
    inputs = HealthPlansInput.model_validate(raw)
    return {
        "inputs": inputs.model_dump(mode="json"),
        "result": health_plans(inputs).model_dump(mode="json"),
    }


cases = [
    case(
        {
            **SAMPLE,
            "expected_usage": usage,
            "selected_plan_index": selected,
            "employee_hsa_cents": hsa,
        }
    )
    for usage in ("low", "medium", "high")
    for selected in (None, 0, 1, 2)
    for hsa in (0, 100_000)
]
cases += [
    case({**SAMPLE, "selected_plan_index": selected, "enrollment_deadline": None})
    for selected in (None, 0, 1, 2)
]
cases += [
    case(
        {
            **SAMPLE,
            "plans": [SILVER],
            "selected_plan_index": selected,
            "enrollment_deadline": None,
        }
    )
    for selected in (None, 0)
]
cases += [
    case(
        {
            **SAMPLE,
            "plans": [{**BRONZE, "deductible_cents": 150_000}, GOLD, SAVER],
            "employee_hsa_cents": 100_000,
        }
    ),
    case({**SAMPLE, "employee_hsa_cents": 500_000}),
]
Path(__file__).with_name("health-plans-results.json").write_text(
    json.dumps(cases, indent=2) + "\n"
)
