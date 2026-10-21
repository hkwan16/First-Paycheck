"""The recurring suite: spec 009's detector over two labeled Plaid sandbox histories.

No LLM, no database, no network. Two cases:

- ``recorded-sandbox``: the real ``/transactions/sync`` page recorded from the
  Plaid sandbox (``api/tests/fixtures/plaid/recorded/``), parsed by the
  production ``PlaidProvider``. The sandbox repeats its merchants every 30
  days, so every money-out merchant there is a monthly series except the two
  Uber descriptions, which normalize to one merchant on a 13/17-day rhythm.
  Labels: ``evals/fixtures/recurring/recorded_sandbox_labels.json``, by hand.
- ``custom-user``: the seeded Plaid custom sandbox user
  (``evals/gen/recurring_user.py``): subscriptions, bills, a variable utility,
  a price change, a one-off at a subscription merchant, a cancelled charge, a
  weekly class, a yearly membership, and irregular spending that must not be
  flagged. Labels come from how the generator built each series.

Metrics (deterministic, no drop tolerated), over both cases together, with a
detection matched to a label by ``(merchant_norm, cadence)``:

- ``precision``: matched detections / detections.
- ``recall``: matched labels / labels.
- ``fields_exact``: of the matches, the share whose typical amount (when the
  label has one) and overdue flag equal the label's.
"""

from __future__ import annotations

import datetime as dt
import json
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from pydantic import SecretStr

from db.enums import RecurringCadence
from evals.gen import recurring_user
from evals.suites.base import Budget, Suite, SuiteResult
from sync.categorize import normalize_merchant
from sync.plaid.provider import PlaidProvider, to_cents
from sync.recurring import Charge, detect

REPO = Path(__file__).resolve().parents[2]
RECORDED_PAGE = (
    REPO / "api" / "tests" / "fixtures" / "plaid" / "recorded" / "transactions_sync_page1.json"
)
RECORDED_LABELS = REPO / "evals" / "fixtures" / "recurring" / "recorded_sandbox_labels.json"
# The day the sandbox history was recorded; its newest transaction is dated then.
RECORDED_TODAY = dt.date(2026, 10, 21)


@dataclass(frozen=True)
class Label:
    merchant_norm: str
    cadence: RecurringCadence
    # None for a bill whose amount varies: only the cadence is checked.
    typical_amount_cents: int | None
    overdue: bool


@dataclass(frozen=True)
class Case:
    id: str
    today: dt.date
    charges: list[Charge]
    labels: list[Label]


def _labels(path: Path) -> list[Label]:
    return [
        Label(
            merchant_norm=item["merchant_norm"],
            cadence=RecurringCadence(item["cadence"]),
            typical_amount_cents=item["typical_amount_cents"],
            overdue=item["overdue"],
        )
        for item in json.loads(path.read_text())
    ]


class _RecordedClient:
    """Answers ``transactions_sync`` with the recorded page; nothing else is called."""

    def __init__(self, page: dict[str, Any]) -> None:
        self._page = page

    def transactions_sync(self, access_token: SecretStr, cursor: str | None) -> dict[str, Any]:
        return self._page

    def accounts_get(self, access_token: SecretStr) -> dict[str, Any]:
        raise AssertionError("the recurring suite reads transactions only")

    def investments_holdings_get(self, access_token: SecretStr) -> dict[str, Any]:
        raise AssertionError("the recurring suite reads transactions only")


def _recorded_charges() -> list[Charge]:
    page = json.loads(RECORDED_PAGE.read_text(), parse_float=Decimal)
    provider = PlaidProvider(_RecordedClient(page), SecretStr("recorded"))
    added = provider.fetch_transactions(None).added
    return [
        Charge(
            merchant_norm=normalize_merchant(txn.merchant_raw),
            merchant_raw=txn.merchant_raw,
            merchant_clean=txn.merchant_clean,
            posted_at=txn.posted_at,
            amount_cents=txn.amount_cents,
        )
        for txn in added
        if not txn.pending
    ]


def _custom_user_charges() -> list[Charge]:
    config = json.loads(recurring_user.CONFIG_PATH.read_text(), parse_float=Decimal)
    return [
        Charge(
            merchant_norm=normalize_merchant(txn["description"]),
            merchant_raw=txn["description"],
            merchant_clean=None,
            posted_at=dt.date.fromisoformat(txn["date_posted"]),
            amount_cents=to_cents(txn["amount"]),
        )
        for account in config["override_accounts"]
        for txn in account["transactions"]
    ]


def load_cases() -> list[Case]:
    return [
        Case(
            id="recorded-sandbox",
            today=RECORDED_TODAY,
            charges=_recorded_charges(),
            labels=_labels(RECORDED_LABELS),
        ),
        Case(
            id="custom-user",
            today=recurring_user.TODAY,
            charges=_custom_user_charges(),
            labels=_labels(recurring_user.LABELS_PATH),
        ),
    ]


def score(cases: Sequence[Case]) -> SuiteResult:
    detected_total = labeled_total = matched = exact = 0
    failures: list[str] = []
    for case in cases:
        found = {(d.merchant_norm, d.cadence): d for d in detect(case.charges, case.today)}
        labels = {(label.merchant_norm, label.cadence): label for label in case.labels}
        detected_total += len(found)
        labeled_total += len(labels)
        for key in sorted(found.keys() | labels.keys()):
            merchant, cadence = key
            detection, label = found.get(key), labels.get(key)
            if label is None:
                failures.append(f"{case.id}: {merchant} {cadence.value} detected, not labeled")
            elif detection is None:
                failures.append(f"{case.id}: {merchant} {cadence.value} labeled, not detected")
            else:
                matched += 1
                amount_ok = label.typical_amount_cents in (None, detection.typical_amount_cents)
                if amount_ok and detection.overdue == label.overdue:
                    exact += 1
                else:
                    failures.append(
                        f"{case.id}: {merchant} {cadence.value} expected typical"
                        f" {label.typical_amount_cents} overdue {label.overdue}, got"
                        f" {detection.typical_amount_cents} overdue {detection.overdue}"
                    )
    return SuiteResult(
        metrics={
            "precision": matched / detected_total if detected_total else 1.0,
            "recall": matched / labeled_total if labeled_total else 1.0,
            "fields_exact": exact / matched if matched else 1.0,
        },
        cases=len(cases),
        failures=failures,
    )


def run(budget: Budget) -> SuiteResult:
    return score(load_cases())


SUITE = Suite(name="recurring", llm=False, run=run)
