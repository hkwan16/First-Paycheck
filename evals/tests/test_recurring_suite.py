"""The recurring suite, its labels and the seeded custom-user generator."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from db.enums import RecurringCadence
from evals.gen import recurring_user as gen
from evals.suites import SUITES, recurring
from evals.suites.base import Budget
from sync.recurring import Charge

BASELINE = Path(__file__).resolve().parents[1] / "baseline.json"


def test_the_committed_custom_user_regenerates_identically(tmp_path: Path) -> None:
    config, labels = tmp_path / "custom_user.json", tmp_path / "custom_user_labels.json"
    gen.write(config, labels)
    stale = "evals/fixtures/recurring is stale: run `uv run python -m evals.gen.recurring_user`"
    assert config.read_text() == gen.CONFIG_PATH.read_text(), stale
    assert labels.read_text() == gen.LABELS_PATH.read_text(), stale


def test_generation_is_deterministic_and_seed_dependent() -> None:
    assert gen.generate() == gen.generate()
    assert gen.generate(seed=1)[0] != gen.generate()[0]


def test_custom_user_is_a_plaid_custom_user_config() -> None:
    config = json.loads(gen.CONFIG_PATH.read_text())
    assert set(config) == {"override_accounts"}
    for account in config["override_accounts"]:
        assert {"type", "subtype", "starting_balance", "meta", "transactions"} <= set(account)
        for txn in account["transactions"]:
            assert set(txn) == {
                "date_transacted",
                "date_posted",
                "amount",
                "description",
                "currency",
            }
            assert dt.date.fromisoformat(txn["date_posted"]) <= gen.TODAY


def test_labels_name_real_cadences() -> None:
    for path in (gen.LABELS_PATH, recurring.RECORDED_LABELS):
        for item in json.loads(path.read_text()):
            assert set(item) == {"merchant_norm", "cadence", "typical_amount_cents", "overdue"}
            RecurringCadence(item["cadence"])


def test_both_cases_load_charges() -> None:
    cases = recurring.load_cases()
    assert [case.id for case in cases] == ["recorded-sandbox", "custom-user"]
    recorded, custom = cases
    # 49 recorded transactions, none pending; the refunds and income are kept
    # here and dropped by detection.
    assert len(recorded.charges) == 49
    assert any(charge.amount_cents < 0 for charge in custom.charges)
    assert len(custom.charges) > 500


def test_suite_meets_its_targets() -> None:
    result = recurring.run(Budget(0))
    assert set(result.metrics) == {"precision", "recall", "fields_exact"}
    assert result.cost_cents == 0.0
    # Spec 009's target is at least 90% precision and recall (technical spec, metrics).
    assert result.metrics["precision"] >= 0.9
    assert result.metrics["recall"] >= 0.9


def charge(merchant: str, day: str, cents: int) -> Charge:
    return Charge(
        merchant_norm=merchant,
        merchant_raw=merchant,
        merchant_clean=None,
        posted_at=dt.date.fromisoformat(day),
        amount_cents=cents,
    )


def test_scoring_on_hand_made_cases() -> None:
    monthly = [charge("gym", f"2026-0{m}-01", 4999) for m in (6, 7, 8, 9)]
    weekly = [charge("class", f"2026-09-{d:02d}", 1500) for d in (1, 8, 15, 22)]
    case = recurring.Case(
        id="hand",
        today=dt.date(2026, 9, 25),
        charges=[*monthly, *weekly],
        labels=[
            recurring.Label("gym", RecurringCadence.MONTHLY, 4999, False),
            recurring.Label("rent", RecurringCadence.MONTHLY, 185_000, False),
        ],
    )
    result = recurring.score([case])
    assert result.metrics == {"precision": 0.5, "recall": 0.5, "fields_exact": 1.0}
    assert result.failures == [
        "hand: class weekly detected, not labeled",
        "hand: rent monthly labeled, not detected",
    ]


def test_registered_with_a_baseline() -> None:
    assert SUITES["recurring"] is recurring.SUITE
    assert not recurring.SUITE.llm
    assert "recurring" in json.loads(BASELINE.read_text())
