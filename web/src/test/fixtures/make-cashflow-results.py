"""Write cashflow-results.json: for each cash-flow fixture, the period's
withholding (api/calc/cashflow.py:withholding), its spending totals
(api/calc/spending.py:summarize) and the diagram (api/calc/cashflow.py:diagram,
spec 010 rule 5b), all computed by the API's own code. The web app never adds
money, and neither do its tests: fixtures/cashflow.ts and fixtures/checkins.ts
attach these diagrams, build the newer fixtures from these totals, and
cashflow-results.test.ts checks the hand-written fixtures still match them.

Cases:
- sample: the sample user's October 1 to 17, two Acme stubs (spec 010 example 2).
- sandbox: the Plaid sandbox's October, no stub (spec 010 route row 4), with
  United Airlines' 500.00 refund and the GUSTO PAY outflow.
- dynamic: user_transactions_dynamic's October, no stub; the payroll the seed
  rules filed under dining nets that category to money in.
- november: spec 015's November user, stub S2 and its eight transactions.
- september: spec 007's September, two Acme stubs (spec 010 diagram example D2).
- beyond: issue 236, one Acme stub, 3,240.12 deposited and 5,234.98 spent
  (spec 010 diagram example D1).
- not_deposited: one Acme stub, 1,500.00 deposited (diagram example D4).
- empty: a period with nothing in it (diagram example D6).
- no_income: the e2e sandbox user's September: a few charges, no deposit.

Run from api/, then format:
    uv run python ../web/src/test/fixtures/make-cashflow-results.py
    (cd ../web && pnpm exec prettier --write src/test/fixtures/cashflow-results.json)
"""

import json
from pathlib import Path

from calc.cashflow import diagram, withholding
from calc.pay_stub import PayStubAmounts
from calc.spending import CategorySum, summarize
from sync.categories import CATEGORY_BUCKETS

ACME = PayStubAmounts(
    gross_cents=270_833,
    federal_withholding_cents=29_776,
    social_security_cents=16_792,
    medicare_cents=3_927,
    state_tax_cents=9_814,
    retirement_contribution_cents=0,
    medical_premium_cents=6_250,
    other_deductions_cents=4_670,
    net_cents=199_604,
)
# Spec 015's stub S2 (web/src/test/fixtures/checkins.ts).
S2 = PayStubAmounts(
    gross_cents=270_833,
    federal_withholding_cents=21_196,
    social_security_cents=16_792,
    medicare_cents=3_927,
    state_tax_cents=9_814,
    retirement_contribution_cents=5_417,
    medical_premium_cents=3_125,
    other_deductions_cents=4_670,
    net_cents=205_892,
)


def out(category: str | None, cents: int, count: int = 1) -> CategorySum:
    return CategorySum(category=category, out_cents=cents, in_cents=0, count=count, out_count=count)


def into(category: str, cents: int, count: int = 1) -> CategorySum:
    return CategorySum(category=category, out_cents=0, in_cents=cents, count=count, out_count=0)


CASES: dict[str, tuple[list[PayStubAmounts], list[CategorySum]]] = {
    "sample": (
        [ACME, ACME],
        [
            into("income", 399_208, 2),
            out("housing", 145_000),
            out("utilities", 6_140),
            out("phone_internet", 7_000),
            out("groceries", 17_545, 2),
            out("dining", 2_100, 2),
            out("transport", 6_640, 2),
            out("subscriptions", 2_399, 2),
            out("shopping", 20_490, 2),
            out("savings_investment", 30_000),
        ],
    ),
    "sandbox": (
        [],
        [
            CategorySum(category="income", out_cents=585_000, in_cents=422, count=2, out_count=1),
            CategorySum(
                category="transfer", out_cents=207_850, in_cents=2_500, count=2, out_count=1
            ),
            out("dining", 51_633, 3),
            out("transport", 540),
            out("shopping", 58_940, 2),
            out("entertainment", 7_850),
            into("travel", 50_000),
            out("savings_investment", 100_000),
            out(None, 50_000),
        ],
    ),
    "dynamic": (
        [],
        [
            into("income", 12),
            CategorySum(
                category="transfer", out_cents=150_000, in_cents=151_989, count=4, out_count=2
            ),
            out("groceries", 34_267, 5),
            into("dining", 173_353, 15),
            out("transport", 2_213, 2),
            out("subscriptions", 3_521, 3),
            out("shopping", 46_655, 13),
            out("travel", 18_600),
            out("personal_care", 2_598),
            out(None, 121_602, 35),
        ],
    ),
    "november": (
        [S2],
        [
            into("income", 205_892),
            out("utilities", 8_215),
            out("phone_internet", 7_000),
            out("groceries", 7_325),
            out("dining", 2_150),
            out("transport", 3_320),
            out("subscriptions", 1_699),
            out("personal_care", 18_500),
            out("savings_investment", 30_000),
        ],
    ),
    "september": (
        [ACME, ACME],
        [
            into("income", 399_208, 2),
            out("housing", 150_000),
            CategorySum(
                category="groceries", out_cents=32_000, in_cents=2_000, count=2, out_count=1
            ),
            out("dining", 8_500),
            out("fees", 3_900),
            out("savings_investment", 40_000),
        ],
    ),
    "beyond": (
        [ACME],
        [
            into("income", 324_012, 3),
            out("housing", 250_000),
            out("groceries", 60_000, 4),
            out("dining", 80_000, 9),
            out("shopping", 131_344, 6),
            out("savings_investment", 2_154),
        ],
    ),
    "not_deposited": (
        [ACME],
        [into("income", 150_000), out("housing", 100_000)],
    ),
    "empty": ([], []),
    "no_income": ([], [out("transport", 633), out("travel", 50_000, 2)]),
}


def main() -> None:
    results = {}
    for name, (stubs, sums) in CASES.items():
        flow = withholding(stubs)
        totals = summarize(sums, CATEGORY_BUCKETS)
        results[name] = {
            "withholding": {
                **flow.total.model_dump(mode="json"),
                "paycheck_count": flow.paycheck_count,
            },
            "spending": totals.model_dump(mode="json"),
            "diagram": diagram(
                flow,
                income_cents=totals.income_cents,
                left_over_cents=totals.left_over_cents,
                categories=totals.categories,
            ).model_dump(mode="json"),
        }
    path = Path(__file__).with_name("cashflow-results.json")
    path.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
