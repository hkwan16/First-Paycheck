"""Seeded generator for the recurring suite's custom Plaid sandbox user.

Writes two files under ``evals/fixtures/recurring/``:

- ``custom_user.json``: a Plaid sandbox custom-user configuration
  (``override_accounts`` with ``transactions`` of ``date_transacted``,
  ``date_posted``, ``amount``, ``description``, ``currency``). Pasted into the
  Plaid dashboard as the password of a ``user_custom`` login, it creates a
  sandbox user with exactly these transactions; the suite reads the same file
  directly, so the eval needs no network. Amounts follow Plaid's sign
  convention: positive is money out.
- ``custom_user_labels.json``: the truth, written from how each series was
  built, never from what the detector says. Each label is a recurring series
  by spec 009's definition (weekly, monthly or yearly money out at a stable
  amount); ``typical_amount_cents`` is null for a bill whose amount varies.

    uv run python -m evals.gen.recurring_user      # rewrite both files

The output depends only on ``SEED``; a test checks the committed files match.
"""

from __future__ import annotations

import datetime as dt
import json
import random
import string
import sys
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

SEED = 909
START = dt.date(2025, 1, 1)
# The eval's "today": the day the history ends.
TODAY = dt.date(2026, 10, 21)
DIRECTORY = Path(__file__).resolve().parents[1] / "fixtures" / "recurring"
CONFIG_PATH = DIRECTORY / "custom_user.json"
LABELS_PATH = DIRECTORY / "custom_user_labels.json"


@dataclass
class Account:
    type: str
    subtype: str
    name: str
    mask: str
    starting_balance: int
    transactions: list[dict[str, Any]] = field(default_factory=list)

    def add(self, day: dt.date, cents: int, description: str) -> None:
        if day > TODAY or day < START:
            return
        self.transactions.append(
            {
                "date_transacted": day.isoformat(),
                "date_posted": day.isoformat(),
                # Plaid reads a JSON number; two decimals print exactly.
                "amount": float(Decimal(cents) / 100),
                "description": description,
                "currency": "USD",
            }
        )

    def config(self) -> dict[str, Any]:
        ordered = sorted(
            self.transactions, key=lambda t: (t["date_posted"], t["description"], t["amount"])
        )
        return {
            "type": self.type,
            "subtype": self.subtype,
            "starting_balance": self.starting_balance,
            "meta": {"name": self.name, "official_name": self.name, "mask": self.mask},
            "transactions": ordered,
        }


def _months() -> list[tuple[int, int]]:
    months = []
    year, month = START.year, START.month
    while (year, month) <= (TODAY.year, TODAY.month):
        months.append((year, month))
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return months


def _last_day(year: int, month: int) -> int:
    following = dt.date(year + 1, 1, 1) if month == 12 else dt.date(year, month + 1, 1)
    return (following - dt.timedelta(days=1)).day


def _days() -> list[dt.date]:
    return [START + dt.timedelta(days=n) for n in range((TODAY - START).days + 1)]


def _ref(rng: random.Random) -> str:
    # Always contains a digit, so normalization drops it (spec 003 rule 1).
    letters = "".join(rng.choices(string.ascii_uppercase + string.digits, k=5))
    return f"{letters}{rng.randrange(10)}"


def generate(seed: int = SEED) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    rng = random.Random(seed)  # noqa: S311 (reproducible synthetic data, not security)
    checking = Account("depository", "checking", "Paycheck Checking", "4821", 2500)
    card = Account("credit", "credit card", "Everyday Card", "3333", 0)
    labels: list[dict[str, Any]] = []

    def label(merchant_norm: str, cadence: str, typical: int | None, overdue: bool) -> None:
        labels.append(
            {
                "merchant_norm": merchant_norm,
                "cadence": cadence,
                "typical_amount_cents": typical,
                "overdue": overdue,
            }
        )

    months = _months()
    for year, month in months:
        last = _last_day(year, month)
        # Pay arrives on the 15th and the last day: income, never a charge.
        for pay_day in (15, last):
            checking.add(dt.date(year, month, pay_day), -199_604, "ACME CORP PAYROLL PPD")
        checking.add(dt.date(year, month, 1), 185_000, "PARKSIDE APTS RENT")
        # A utility bill that varies (62-98 dollars) and posts a day or two either side.
        bill_day = dt.date(year, month, 14) + dt.timedelta(days=rng.randint(-2, 2))
        checking.add(bill_day, rng.randint(6_200, 9_800), "PG&E WEB ONLINE")
        checking.add(dt.date(year, month, 20), 7_999, "COMCAST XFINITY")
        checking.add(dt.date(year, month, 25), 20_000, "TRANSFER TO SAVINGS 7730")
        # Netflix went from 15.49 to 16.99 in June 2026 (9.7%, inside the series).
        netflix = 1_699 if (year, month) >= (2026, 6) else 1_549
        card.add(dt.date(year, month, 3), netflix, "NETFLIX.COM")
        card.add(dt.date(year, month, 12), 1_199, "SPOTIFY USA")
        # Hulu was cancelled after the July 2026 charge.
        if (year, month) <= (2026, 7):
            card.add(dt.date(year, month, 8), 799, "HULU 877-8244858")
        card.add(dt.date(year, month, 17), 299, "APPLE.COM/BILL")
    label("parkside apts rent", "monthly", 185_000, False)
    label("pg&e web online", "monthly", None, False)
    label("comcast xfinity", "monthly", 7_999, False)
    label("transfer to savings", "monthly", 20_000, False)
    label("netflix.com", "monthly", 1_699, False)
    label("spotify usa", "monthly", 1_199, False)
    label("hulu", "monthly", 799, True)
    label("apple.com bill", "monthly", 299, False)

    # Two app purchases at the same merchant as iCloud: one-offs, outside the series.
    card.add(dt.date(2026, 3, 22), 999, "APPLE.COM/BILL")
    card.add(dt.date(2026, 8, 5), 999, "APPLE.COM/BILL")

    for year in (2025, 2026):
        card.add(dt.date(year, 2, 14), 13_900, "AMAZON PRIME*" + _ref(rng))
    label("amazon prime", "yearly", 13_900, False)

    class_day = dt.date(2026, 6, 2)
    while class_day <= TODAY:
        card.add(class_day, 2_000, "CORE POWER YOGA")
        class_day += dt.timedelta(days=7)
    label("core power yoga", "weekly", 2_000, False)

    # Irregular spending: never recurring.
    for day in _days():
        if rng.random() < 0.3:
            card.add(day, rng.randint(395, 745), f"STARBUCKS STORE {rng.randint(1000, 99999)}")
        if rng.random() < 0.18:
            checking.add(day, rng.randint(2_500, 16_000), f"SAFEWAY #{rng.randint(100, 3000)}")
        if rng.random() < 0.1:
            card.add(day, rng.randint(800, 12_000), f"AMZN Mktp US*{_ref(rng)}")
        if rng.random() < 0.12:
            card.add(day, rng.randint(900, 3_400), "UBER *TRIP")
        if rng.random() < 0.04:
            # A refund: money in, ignored by detection.
            card.add(day, -rng.randint(800, 5_000), f"AMZN Mktp US*{_ref(rng)}")

    config = {"override_accounts": [checking.config(), card.config()]}
    labels.sort(key=lambda item: (item["merchant_norm"], item["cadence"]))
    return config, labels


def _dump(data: Any) -> str:
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def write(config_path: Path = CONFIG_PATH, labels_path: Path = LABELS_PATH) -> None:
    config, labels = generate()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(_dump(config))
    labels_path.write_text(_dump(labels))


def main() -> int:
    write()
    sys.stdout.write(f"wrote {CONFIG_PATH} and {LABELS_PATH}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
