"""Seeded generator for ``evals/fixtures/transactions.csv``: 500 synthetic,
labeled bank transactions for the categorization suites, then 15 written by
hand for direction (spec 003 rules 3a-3b and 5a).

Merchant descriptions mimic what banks send (store numbers, processor
prefixes, cities, reference codes). Most merchants are ones the seed rules
know; about a fifth are local businesses no rule covers (the LLM's share), and
a few are traps where a whole-token prefix rule picks the wrong category.
The labels are the true categories, never what the rules say.

The hand-written rows (``SIGN_CASES``, ids 501-515) come after the seeded
ones, so adding them left rows 1-500 unchanged: paychecks from employers named
like merchants, the bank language of loan and card ledgers (the shape of
Plaid's ``user_transactions_dynamic`` sandbox user), ``Interest`` in both
directions, and two refunds, whose true label is their spending category.

    uv run python -m evals.gen.transactions      # rewrite the committed CSV

The output depends only on ``SEED``; a test checks the committed file matches.
"""

from __future__ import annotations

import csv
import datetime as dt
import random
import string
import sys
from dataclasses import dataclass
from pathlib import Path

SEED = 146
ROWS = 500
START = dt.date(2026, 7, 1)
DAYS = 112
DEFAULT_CSV = Path(__file__).resolve().parents[1] / "fixtures" / "transactions.csv"
FIELDS = ["id", "merchant_raw", "amount_cents", "posted_at", "category"]

CITIES = [
    "SAN JOSE CA",
    "OAKLAND CA",
    "SEATTLE WA",
    "AUSTIN TX",
    "BROOKLYN NY",
    "CHICAGO IL",
    "DENVER CO",
    "BOSTON MA",
]


@dataclass(frozen=True)
class Merchant:
    # Placeholders: {n} store number, {city} city and state, {ref} reference code.
    template: str
    category: str
    low_cents: int
    high_cents: int
    weight: int = 3


@dataclass(frozen=True)
class Row:
    id: int
    merchant_raw: str
    amount_cents: int
    posted_at: dt.date
    category: str


# Merchants the seed rules know.
KNOWN = [
    Merchant("SAFEWAY #{n} {city}", "groceries", 1_200, 14_000, 8),
    Merchant("TRADER JOE'S #{n}", "groceries", 900, 9_000, 8),
    Merchant("WHOLEFDS MKT {n}", "groceries", 1_500, 12_000, 4),
    Merchant("INSTACART*{ref}", "groceries", 3_000, 16_000, 3),
    Merchant("KROGER #{n}", "groceries", 1_000, 11_000, 3),
    Merchant("STARBUCKS STORE {n} {city}", "dining", 350, 1_400, 8),
    Merchant("CHIPOTLE {n}", "dining", 900, 2_200, 5),
    Merchant("SQ *BLUE BOTTLE COFFEE", "dining", 450, 1_200, 4),
    Merchant("DOORDASH*{ref}", "dining", 1_800, 6_000, 5),
    Merchant("UBER EATS {ref}", "dining", 1_500, 5_500, 3),
    Merchant("MCDONALD'S F{n}", "dining", 500, 1_500, 3),
    Merchant("UBER *TRIP {ref}", "transport", 700, 4_500, 6),
    Merchant("LYFT *RIDE {ref}", "transport", 800, 4_000, 3),
    Merchant("SHELL OIL {n}", "transport", 2_500, 7_000, 4),
    Merchant("CLIPPER SERVICE {ref}", "transport", 2_000, 8_600, 2),
    Merchant("NETFLIX.COM", "subscriptions", 1_549, 2_299, 3),
    Merchant("SPOTIFY USA", "subscriptions", 1_199, 1_199, 3),
    Merchant("APPLE.COM/BILL", "subscriptions", 99, 1_499, 3),
    Merchant("AMAZON PRIME*{ref}", "subscriptions", 1_499, 1_499, 2),
    Merchant("HULU {n}", "subscriptions", 799, 1_799, 2),
    Merchant("AMZN MKTP US*{ref}", "shopping", 800, 15_000, 7),
    Merchant("TARGET {n}", "shopping", 1_000, 12_000, 5),
    Merchant("COSTCO WHSE #{n}", "shopping", 4_000, 30_000, 3),
    Merchant("BEST BUY {n}", "shopping", 2_000, 60_000, 2),
    Merchant("PG&E WEBRECURRING", "utilities", 4_000, 18_000, 3),
    Merchant("COMCAST CABLE COMM", "phone_internet", 5_000, 9_000, 3),
    Merchant("T-MOBILE POSTPAID {ref}", "phone_internet", 4_500, 9_000, 3),
    Merchant("GEICO *AUTO", "insurance", 9_000, 16_000, 2),
    Merchant("LEMONADE INSURANCE", "insurance", 1_000, 2_500, 2),
    Merchant("CVS/PHARMACY #{n}", "healthcare", 500, 4_500, 3),
    Merchant("WALGREENS #{n}", "healthcare", 400, 3_000, 2),
    Merchant("PLANET FITNESS {ref}", "personal_care", 1_000, 2_499, 2),
    Merchant("UNITED AIRLINES {ref}", "travel", 15_000, 60_000, 1),
    Merchant("AIRBNB * {ref}", "travel", 20_000, 90_000, 1),
    Merchant("AMC THEATRES {n}", "entertainment", 1_200, 4_000, 2),
    Merchant("STEAM PURCHASE {ref}", "entertainment", 500, 6_000, 2),
    Merchant("RENT PAYMENT {ref}", "housing", 180_000, 260_000, 3),
    Merchant("BILT RENT {ref}", "housing", 180_000, 260_000, 1),
    Merchant("GUSTO PAY {n}", "income", -380_000, -250_000, 4),
    Merchant("ADP PAYROLL {ref}", "income", -380_000, -250_000, 2),
    Merchant("INTEREST PAYMENT", "income", -900, -50, 2),
    Merchant("VENMO PAYMENT {ref}", "transfer", 1_000, 8_000, 3),
    Merchant("ZELLE TO {ref}", "transfer", 2_000, 20_000, 2),
    Merchant("ONLINE TRANSFER TO SAV {ref}", "transfer", 10_000, 50_000, 3),
    Merchant("CREDIT CARD PAYMENT {ref}", "transfer", 20_000, 150_000, 3),
    Merchant("NELNET STUDENT LOAN", "debt_payment", 15_000, 40_000, 2),
    Merchant("VANGUARD BUY {ref}", "savings_investment", 10_000, 50_000, 2),
    Merchant("OVERDRAFT FEE", "fees", 3_500, 3_500, 1),
    Merchant("IRS TREAS 310 TAX REF", "taxes", 5_000, 90_000, 1),
    Merchant("COURSERA {ref}", "education", 4_900, 4_900, 1),
    Merchant("RED CROSS DONATION", "gifts_donations", 2_500, 10_000, 1),
]

# Merchants no rule knows: local businesses and odd descriptors.
UNKNOWN = [
    Merchant("TST* JOE'S DINER", "dining", 1_100, 3_500, 3),
    Merchant("SQ *SUNRISE BAKERY", "dining", 400, 1_800, 3),
    Merchant("LA TAQUERIA {n}", "dining", 900, 2_400, 2),
    Merchant("CORNER BODEGA {ref}", "groceries", 300, 2_500, 3),
    Merchant("BERKELEY BOWL {n}", "groceries", 2_000, 9_000, 2),
    Merchant("CITY OF SAN JOSE PARKING", "transport", 200, 2_400, 2),
    Merchant("JIFFY LUBE #{n}", "transport", 5_000, 12_000, 1),
    Merchant("DR LEE DDS {ref}", "healthcare", 5_000, 25_000, 1),
    Merchant("SUNRISE YOGA STUDIO", "personal_care", 2_000, 15_000, 2),
    Merchant("FANTASTIC SAMS {n}", "personal_care", 2_500, 4_500, 1),
    Merchant("GREEN EARTH CLEANERS", "personal_care", 1_500, 4_000, 1),
    Merchant("PAPER & PLANT CO", "shopping", 1_200, 6_000, 2),
    Merchant("MUNI WATER DEPT {ref}", "utilities", 3_000, 9_000, 1),
    Merchant("KQED MEMBERSHIP", "gifts_donations", 1_000, 6_000, 1),
    Merchant("STUDIO GHIBLI FEST {ref}", "entertainment", 1_500, 3_000, 1),
    Merchant("ACME CORP PAYROLL", "income", -400_000, -280_000, 2),
    Merchant("SPRINGFIELD LIBRARY FINE", "fees", 100, 900, 1),
    Merchant("GOLDEN GATE TRANSIT {ref}", "transport", 300, 1_200, 2),
]

# Traps: a whole-token prefix rule fires and gets the category wrong.
TRAPS = [
    Merchant("RENT THE RUNWAY {ref}", "shopping", 6_000, 15_000, 2),
    Merchant("SHELL BEACH SURF SHOP", "shopping", 2_000, 9_000, 1),
    Merchant("TARGET OPTICAL {n}", "healthcare", 8_000, 25_000, 1),
]

POOL = [*KNOWN, *UNKNOWN, *TRAPS]

# Written by hand, appended after the seeded rows: (merchant_raw, amount_cents
# with positive out, posted_at, true category). Spec 003 rules 3a-3b and 5a.
SIGN_CASES: list[tuple[str, int, dt.date, str]] = [
    # Paychecks from employers whose names start like a merchant's.
    ("Sweetgreen inc payroll ppd id", -81_000, dt.date(2026, 9, 23), "income"),
    ("Sweetgreen inc payroll ppd id", -81_000, dt.date(2026, 9, 30), "income"),
    ("SWEETGREEN #0412 SEATTLE WA", 1_450, dt.date(2026, 9, 24), "dining"),
    ("STARBUCKS CORP DIRECT DEP", -254_300, dt.date(2026, 10, 1), "income"),
    ("PLANET FITNESS PAYROLL", -198_000, dt.date(2026, 10, 2), "income"),
    # The bank language of loan and card ledgers.
    ("Monthly payment", -31_195, dt.date(2026, 9, 29), "transfer"),
    ("Monthly payment", -12_500, dt.date(2026, 10, 13), "transfer"),
    ("Interest charged", 10_788, dt.date(2026, 9, 22), "fees"),
    ("Interest charged", 4_520, dt.date(2026, 10, 6), "fees"),
    ("Payment", -283_580, dt.date(2026, 10, 14), "transfer"),
    ("Interest", 11_147, dt.date(2026, 9, 22), "fees"),
    ("Interest", -12, dt.date(2026, 10, 15), "income"),
    ("CASH DEPOSIT", -49_600, dt.date(2026, 10, 15), "transfer"),
    # Refunds: money in at a merchant, labeled with its spending category.
    ("UNITED AIRLINES REFUND", -45_000, dt.date(2026, 8, 19), "travel"),
    ("AMZN MKTP US*RF2291 REFUND", -2_599, dt.date(2026, 9, 3), "shopping"),
]


def _fill(template: str, rng: random.Random) -> str:
    ref = "".join(rng.choices(string.ascii_uppercase, k=2)) + str(rng.randint(10, 9999))
    return template.format(n=f"{rng.randint(100, 99999):05d}", city=rng.choice(CITIES), ref=ref)


def generate(seed: int = SEED, rows: int = ROWS) -> list[Row]:
    rng = random.Random(seed)  # noqa: S311 (reproducible synthetic data, not security)
    weights = [merchant.weight for merchant in POOL]
    generated = []
    for index in range(1, rows + 1):
        merchant = rng.choices(POOL, weights=weights)[0]
        generated.append(
            Row(
                id=index,
                merchant_raw=_fill(merchant.template, rng),
                amount_cents=rng.randint(merchant.low_cents, merchant.high_cents),
                posted_at=START + dt.timedelta(days=rng.randrange(DAYS)),
                category=merchant.category,
            )
        )
    for index, (merchant_raw, amount_cents, posted_at, category) in enumerate(
        SIGN_CASES, start=rows + 1
    ):
        generated.append(Row(index, merchant_raw, amount_cents, posted_at, category))
    return generated


def write_csv(path: Path = DEFAULT_CSV, rows: list[Row] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(FIELDS)
        for row in generate() if rows is None else rows:
            writer.writerow(
                [
                    row.id,
                    row.merchant_raw,
                    row.amount_cents,
                    row.posted_at.isoformat(),
                    row.category,
                ]
            )


def read_csv(path: Path = DEFAULT_CSV) -> list[Row]:
    with path.open(newline="", encoding="utf-8") as handle:
        return [
            Row(
                id=int(record["id"]),
                merchant_raw=record["merchant_raw"],
                amount_cents=int(record["amount_cents"]),
                posted_at=dt.date.fromisoformat(record["posted_at"]),
                category=record["category"],
            )
            for record in csv.DictReader(handle)
        ]


if __name__ == "__main__":
    write_csv()
    sys.stdout.write(f"wrote {ROWS + len(SIGN_CASES)} rows to {DEFAULT_CSV}\n")
