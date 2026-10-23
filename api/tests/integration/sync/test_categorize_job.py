"""The categorize job and user corrections against Postgres (spec 003 rules 6-16)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Connection, text

from app.db import user_session_for
from db.enums import CategorySource, JobKind
from jobs import queue
from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from llm.gateway import CategorizeItem, LLMBudgetExceeded, LLMRefused, LLMSchemaError
from llm.schemas import CategoryAssignment, CategoryBatch
from sync.categories import Category
from sync.categorize import categorize_user, record_user_label
from tests.conftest import FixtureUser
from tests.support.anthropic_api import ErroringApi, api_gateway
from tests.support.factories import make_account, make_item, make_transaction


class SpyLabeler:
    """Records every batch; answers from a merchant map or a scripted outcome."""

    def __init__(
        self,
        # Keyed by merchant, or by (merchant, direction) for one direction only.
        answers: Mapping[str | tuple[str, str], tuple[Category, float]] | None = None,
        outcomes: Sequence[Exception | None] = (),
    ) -> None:
        self.answers = answers or {}
        self.outcomes = list(outcomes)
        self.batches: list[list[CategorizeItem]] = []
        self.job_ids: list[uuid.UUID | None] = []

    def categorize(
        self,
        user_id: uuid.UUID,
        items: Sequence[CategorizeItem],
        *,
        job_id: uuid.UUID | None = None,
    ) -> CategoryBatch:
        self.batches.append(list(items))
        self.job_ids.append(job_id)
        outcome = self.outcomes.pop(0) if self.outcomes else None
        if outcome is not None:
            raise outcome
        assignments = []
        for item in items:
            answer = self.answers.get((item.merchant, item.direction)) or self.answers.get(
                item.merchant
            )
            if answer is not None:
                category, confidence = answer
                assignments.append(
                    CategoryAssignment(id=item.id, category=category, confidence=confidence)
                )
        return CategoryBatch(items=assignments)

    @property
    def merchants(self) -> list[str]:
        return [item.merchant for batch in self.batches for item in batch]


def shop_names(count: int) -> list[str]:
    """Distinct digit-free merchant names: zz shop aa, zz shop ab, ..."""
    return [f"zz shop {chr(97 + i // 26)}{chr(97 + i % 26)}" for i in range(count)]


@pytest.fixture
def account(seeded_rules: Connection, user_a: FixtureUser) -> uuid.UUID:
    return make_account(seeded_rules, user_a.id, make_item(seeded_rules, user_a.id))


def labels(connection: Connection, user: FixtureUser) -> dict[str, list[tuple[Any, ...]]]:
    rows = connection.execute(
        text(
            "SELECT merchant_norm, category, category_source::text, confidence"
            " FROM transactions WHERE user_id = :u ORDER BY merchant_norm, posted_at, id"
        ),
        {"u": user.id},
    )
    found: dict[str, list[tuple[Any, ...]]] = {}
    for merchant, category, source, confidence in rows:
        found.setdefault(merchant, []).append((category, source, confidence))
    return found


def run(
    connection: Connection,
    user: FixtureUser,
    labeler: SpyLabeler | None,
    job_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    result = categorize_user(
        user_id=user.id,
        sessions=lambda: user_session_for(user.id, bind=connection),
        labeler=labeler,
        job_id=job_id,
    )
    return result.as_job_result()


def test_rules_first_and_only_unknowns_reach_the_gateway(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="SAFEWAY #1234")
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="UBER   TRIP 0601")
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ LOCAL BAKERY 42")
    labeler = SpyLabeler({"zz local bakery": ("dining", 0.8125)})

    result = run(seeded_rules, user_a, labeler)

    assert labeler.merchants == ["zz local bakery"]
    found = labels(seeded_rules, user_a)
    assert found["safeway"] == [("groceries", "rule", None)]
    assert found["uber trip"] == [("transport", "rule", None)]
    # Confidence is rounded half-up to 3 decimals.
    assert found["zz local bakery"] == [("dining", "llm", Decimal("0.813"))]
    assert result == {
        "rule_labeled": 2,
        "reused": 0,
        "llm_labeled": 1,
        "unresolved": 0,
        "batches": 1,
        "stopped": None,
    }


def test_the_request_carries_only_merchant_amount_and_date(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    make_transaction(
        seeded_rules,
        user_a.id,
        account,
        merchant_raw="ZZ BAKERY",
        amount_cents=450,
        posted_at=dt.date(2026, 10, 1),
    )
    make_transaction(
        seeded_rules,
        user_a.id,
        account,
        merchant_raw="ZZ BAKERY",
        amount_cents=-725,
        posted_at=dt.date(2026, 10, 9),
    )
    make_transaction(
        seeded_rules,
        user_a.id,
        account,
        merchant_raw="ZZ BAKERY",
        amount_cents=380,
        posted_at=dt.date(2026, 10, 3),
    )
    labeler = SpyLabeler({"zz bakery": ("dining", 0.9)})
    run(seeded_rules, user_a, labeler)

    # One item per distinct merchant and direction (spec 003 rule 8), money out
    # first; each sample is the newest transaction of its direction.
    assert labeler.batches == [
        [
            CategorizeItem(id=1, merchant="zz bakery", amount_cents=380, date=dt.date(2026, 10, 3)),
            CategorizeItem(
                id=2, merchant="zz bakery", amount_cents=-725, date=dt.date(2026, 10, 9)
            ),
        ]
    ]
    assert [item.direction for item in labeler.batches[0]] == ["out", "in"]
    # The model's dining is applied to money out only; the money-in row waits.
    assert [row[0] for row in labels(seeded_rules, user_a)["zz bakery"]] == [
        "dining",
        "dining",
        None,
    ]


def test_a_money_in_item_takes_income_or_transfer_from_the_model(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ BAKERY", amount_cents=450)
    make_transaction(
        seeded_rules, user_a.id, account, merchant_raw="ZZ BAKERY INC", amount_cents=-81_000
    )
    labeler = SpyLabeler(
        {("zz bakery", "out"): ("dining", 0.9), ("zz bakery inc", "in"): ("income", 0.8)}
    )

    result = run(seeded_rules, user_a, labeler)

    found = labels(seeded_rules, user_a)
    assert found["zz bakery"] == [("dining", "llm", Decimal("0.900"))]
    assert found["zz bakery inc"] == [("income", "llm", Decimal("0.800"))]
    assert (result["llm_labeled"], result["unresolved"]) == (2, 0)


def test_a_spending_answer_for_money_in_is_dropped(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    """Spec 003 rule 10: the schema cannot tie a category to a direction, so the
    code drops a spending category the model gives a money-in item."""
    make_transaction(
        seeded_rules, user_a.id, account, merchant_raw="ZZ BISTRO PAYOUT", amount_cents=-81_000
    )
    labeler = SpyLabeler({"zz bistro payout": ("dining", 0.9)})

    result = run(seeded_rules, user_a, labeler)

    assert labels(seeded_rules, user_a)["zz bistro payout"] == [(None, None, None)]
    assert (result["llm_labeled"], result["unresolved"]) == (0, 1)


def test_a_previous_llm_label_is_reused_only_in_its_direction(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    make_transaction(
        seeded_rules,
        user_a.id,
        account,
        merchant_raw="ZZ BAKERY",
        posted_at=dt.date(2026, 9, 1),
        category="dining",
        category_source=CategorySource.LLM,
        confidence=Decimal("0.700"),
    )
    make_transaction(
        seeded_rules,
        user_a.id,
        account,
        merchant_raw="ZZ BAKERY",
        amount_cents=-500,
        posted_at=dt.date(2026, 9, 2),
    )
    labeler = SpyLabeler()

    result = run(seeded_rules, user_a, labeler)

    # The money-in row is not given the money-out row's dining: it goes to the model.
    assert [(item.merchant, item.direction) for item in labeler.batches[0]] == [("zz bakery", "in")]
    assert (result["reused"], result["batches"]) == (0, 1)


def test_an_old_spending_llm_label_on_money_in_is_not_reused(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    """A money-in row labeled dining by the model before rule 10 is not copied."""
    make_transaction(
        seeded_rules,
        user_a.id,
        account,
        merchant_raw="ZZ BAKERY",
        amount_cents=-500,
        posted_at=dt.date(2026, 9, 1),
        category="dining",
        category_source=CategorySource.LLM,
        confidence=Decimal("0.700"),
    )
    make_transaction(
        seeded_rules,
        user_a.id,
        account,
        merchant_raw="ZZ BAKERY",
        amount_cents=-600,
        posted_at=dt.date(2026, 9, 2),
    )
    labeler = SpyLabeler()

    result = run(seeded_rules, user_a, labeler)

    assert result["reused"] == 0
    assert [(item.merchant, item.direction) for item in labeler.batches[0]] == [("zz bakery", "in")]


def test_rules_label_a_paycheck_from_a_restaurant_as_income(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    """Spec 003 rule 3b: the seed's sweetgreen (dining) applies to money out only."""
    make_transaction(
        seeded_rules,
        user_a.id,
        account,
        merchant_raw="Sweetgreen inc payroll ppd id",
        amount_cents=-81_000,
    )
    make_transaction(
        seeded_rules, user_a.id, account, merchant_raw="SWEETGREEN #12", amount_cents=1_450
    )
    make_transaction(
        seeded_rules, user_a.id, account, merchant_raw="SWEETGREEN #12", amount_cents=-1_450
    )
    labeler = SpyLabeler()

    result = run(seeded_rules, user_a, labeler)

    found = labels(seeded_rules, user_a)
    assert found["sweetgreen inc payroll ppd id"] == [("income", "rule", None)]
    assert sorted(found["sweetgreen"], key=str) == sorted(
        [("dining", "rule", None), (None, None, None)], key=str
    )
    # The refund goes to the model as a money-in item.
    assert [(item.merchant, item.direction) for item in labeler.batches[0]] == [
        ("sweetgreen", "in")
    ]
    assert result["rule_labeled"] == 2


def test_batches_of_fifty_in_alphabetical_order(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    names = shop_names(120)
    for name in reversed(names):
        make_transaction(seeded_rules, user_a.id, account, merchant_raw=name)
    labeler = SpyLabeler()

    result = run(seeded_rules, user_a, labeler, job_id=None)

    assert [len(batch) for batch in labeler.batches] == [50, 50, 20]
    assert labeler.merchants == sorted(names)
    assert [item.id for item in labeler.batches[2]] == list(range(1, 21))
    # Merchants the model skipped stay uncategorized.
    assert result["unresolved"] == 120
    assert result["batches"] == 3


def test_a_previous_llm_label_is_reused_without_a_call(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    make_transaction(
        seeded_rules,
        user_a.id,
        account,
        merchant_raw="ZZ BAKERY",
        posted_at=dt.date(2026, 9, 1),
        category="dining",
        category_source=CategorySource.LLM,
        confidence=Decimal("0.700"),
    )
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ BAKERY")
    labeler = SpyLabeler()

    result = run(seeded_rules, user_a, labeler)

    assert labeler.batches == []
    assert labels(seeded_rules, user_a)["zz bakery"] == [
        ("dining", "llm", Decimal("0.700")),
        ("dining", "llm", Decimal("0.700")),
    ]
    assert (result["reused"], result["batches"]) == (1, 0)


def test_labeled_and_empty_merchants_are_left_alone(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    make_transaction(
        seeded_rules,
        user_a.id,
        account,
        merchant_raw="SAFEWAY #1",
        category="shopping",
        category_source=CategorySource.USER,
    )
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="#1234")
    labeler = SpyLabeler()

    result = run(seeded_rules, user_a, labeler)

    assert labeler.batches == []
    found = labels(seeded_rules, user_a)
    assert found["safeway"] == [("shopping", "user", None)]
    assert found[""] == [(None, None, None)]
    assert result["unresolved"] == 1


def test_llm_labels_never_become_rules(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ BAKERY")
    run(seeded_rules, user_a, SpyLabeler({"zz bakery": ("dining", 0.9)}))
    count = seeded_rules.execute(
        text("SELECT count(*) FROM category_rules WHERE user_id = :u"), {"u": user_a.id}
    ).scalar_one()
    assert count == 0


def test_budget_stops_llm_work_and_the_job_still_succeeds(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    for name in shop_names(120):
        make_transaction(seeded_rules, user_a.id, account, merchant_raw=name)
    labeler = SpyLabeler(
        {"zz shop aa": ("shopping", 0.9)},
        outcomes=[None, LLMBudgetExceeded("spent")],
    )
    result = run(seeded_rules, user_a, labeler)
    assert result["stopped"] == "budget"
    # The third batch is never attempted.
    assert result["batches"] == 2
    assert (result["llm_labeled"], result["unresolved"]) == (1, 119)


def test_a_refused_batch_is_skipped_and_the_rest_continue(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    names = shop_names(60)
    for name in names:
        make_transaction(seeded_rules, user_a.id, account, merchant_raw=name)
    labeler = SpyLabeler({names[-1]: ("shopping", 0.9)}, outcomes=[LLMRefused("no"), None])

    result = run(seeded_rules, user_a, labeler)

    assert result["stopped"] == "refused"
    assert result["llm_labeled"] == 1
    assert result["unresolved"] == 59


def test_schema_errors_fail_but_keep_earlier_batches(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    names = shop_names(60)
    for name in names:
        make_transaction(seeded_rules, user_a.id, account, merchant_raw=name)
    labeler = SpyLabeler({names[0]: ("shopping", 0.9)}, outcomes=[None, LLMSchemaError("bad")])

    with pytest.raises(LLMSchemaError):
        run(seeded_rules, user_a, labeler)
    assert labels(seeded_rules, user_a)[names[0]] == [("shopping", "llm", Decimal("0.900"))]


def test_ids_outside_the_batch_are_ignored(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ BAKERY")

    class Rogue(SpyLabeler):
        def categorize(
            self,
            user_id: uuid.UUID,
            items: Sequence[CategorizeItem],
            *,
            job_id: uuid.UUID | None = None,
        ) -> CategoryBatch:
            return CategoryBatch(
                items=[CategoryAssignment(id=7, category="dining", confidence=0.9)]
            )

    result = run(seeded_rules, user_a, Rogue())
    assert labels(seeded_rules, user_a)["zz bakery"] == [(None, None, None)]
    assert result["llm_labeled"] == 0


def test_other_users_transactions_are_untouched(
    seeded_rules: Connection, user_a: FixtureUser, user_b: FixtureUser, account: uuid.UUID
) -> None:
    b_account = make_account(seeded_rules, user_b.id, make_item(seeded_rules, user_b.id))
    make_transaction(seeded_rules, user_b.id, b_account, merchant_raw="SAFEWAY #9")
    run(seeded_rules, user_a, SpyLabeler())
    assert labels(seeded_rules, user_b)["safeway"] == [(None, None, None)]


# User corrections --------------------------------------------------------------


def test_fix_relabels_siblings(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    def netflix(**fields: Any) -> uuid.UUID:
        return make_transaction(
            seeded_rules, user_a.id, account, merchant_raw="NETFLIX.COM", **fields
        )

    t1 = netflix(
        category="entertainment", category_source=CategorySource.LLM, confidence=Decimal("0.62")
    )
    t2 = netflix(category="entertainment", category_source=CategorySource.RULE)
    t3 = netflix(category="entertainment", category_source=CategorySource.USER)

    with user_session_for(user_a.id, bind=seeded_rules) as session:
        fix = record_user_label(
            session, user_id=user_a.id, transaction_id=t1, category="subscriptions"
        )
    assert fix is not None
    assert (fix.rule_merchant_norm, fix.relabeled) == ("netflix.com", 1)

    rows: dict[uuid.UUID, str] = dict(
        seeded_rules.execute(
            text(
                "SELECT id, (category, category_source::text, confidence)::text FROM transactions"
                " WHERE user_id = :u"
            ),
            {"u": user_a.id},
        ).all()
    )
    assert rows[t1] == "(subscriptions,user,)"
    assert rows[t2] == "(subscriptions,rule,)"
    assert rows[t3] == "(entertainment,user,)"
    rule = seeded_rules.execute(
        text(
            "SELECT match::text, category, source::text FROM category_rules"
            " WHERE user_id = :u AND merchant_norm = 'netflix.com'"
        ),
        {"u": user_a.id},
    ).one()
    assert tuple(rule) == ("exact", "subscriptions", "user")

    # A later transaction for the merchant is labeled by the rule, never the LLM.
    netflix()
    labeler = SpyLabeler()
    run(seeded_rules, user_a, labeler)
    assert labeler.batches == []
    newest = labels(seeded_rules, user_a)["netflix.com"]
    assert ("subscriptions", "rule", None) in newest


def test_a_spending_fix_on_money_in_keeps_the_row_and_relabels_money_out_only(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    """Spec 003 rules 13-15: the user labels one paycheck dining. The row keeps
    the user's label and the rule is written, but a spending rule labels money
    out only, so the other paychecks stay income."""

    def sweetgreen(amount_cents: int, **fields: Any) -> uuid.UUID:
        return make_transaction(
            seeded_rules,
            user_a.id,
            account,
            merchant_raw="Sweetgreen inc payroll ppd id",
            amount_cents=amount_cents,
            **fields,
        )

    paycheck = sweetgreen(-81_000, category="income", category_source=CategorySource.RULE)
    other_paycheck = sweetgreen(-81_000, category="income", category_source=CategorySource.RULE)
    money_out = sweetgreen(1_200)

    with user_session_for(user_a.id, bind=seeded_rules) as session:
        fix = record_user_label(
            session, user_id=user_a.id, transaction_id=paycheck, category="dining"
        )
    assert fix is not None
    assert (fix.rule_merchant_norm, fix.relabeled) == ("sweetgreen inc payroll ppd id", 1)

    rows: dict[uuid.UUID, str] = dict(
        seeded_rules.execute(
            text(
                "SELECT id, (category, category_source::text)::text FROM transactions"
                " WHERE user_id = :u"
            ),
            {"u": user_a.id},
        ).all()
    )
    assert rows[paycheck] == "(dining,user)"
    assert rows[other_paycheck] == "(income,rule)"
    assert rows[money_out] == "(dining,rule)"
    rule = seeded_rules.execute(
        text(
            "SELECT match::text, category FROM category_rules"
            " WHERE user_id = :u AND merchant_norm = 'sweetgreen inc payroll ppd id'"
        ),
        {"u": user_a.id},
    ).one()
    assert tuple(rule) == ("exact", "dining")

    # A later paycheck skips the user's dining rule and is income by the seed rules.
    later = sweetgreen(-81_000)
    run(seeded_rules, user_a, SpyLabeler())
    assert (
        seeded_rules.execute(
            text("SELECT category FROM transactions WHERE id = :id"), {"id": later}
        ).scalar_one()
        == "income"
    )


def test_an_income_fix_relabels_both_directions(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    first = make_transaction(
        seeded_rules, user_a.id, account, merchant_raw="ZZ ACME", amount_cents=-300_000
    )
    make_transaction(
        seeded_rules, user_a.id, account, merchant_raw="ZZ ACME", amount_cents=-300_000
    )
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ ACME", amount_cents=300_000)
    with user_session_for(user_a.id, bind=seeded_rules) as session:
        fix = record_user_label(session, user_id=user_a.id, transaction_id=first, category="income")
    assert fix is not None
    assert fix.relabeled == 2
    assert [row[0] for row in labels(seeded_rules, user_a)["zz acme"]] == ["income"] * 3


def test_fixing_again_replaces_the_rule(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    txn = make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ BAKERY")
    for category in ("dining", "groceries"):
        with user_session_for(user_a.id, bind=seeded_rules) as session:
            record_user_label(session, user_id=user_a.id, transaction_id=txn, category=category)
    rules = seeded_rules.execute(
        text("SELECT category FROM category_rules WHERE user_id = :u"), {"u": user_a.id}
    ).scalars()
    assert list(rules) == ["groceries"]


def test_an_empty_merchant_gets_a_label_but_no_rule(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    txn = make_transaction(seeded_rules, user_a.id, account, merchant_raw="#1234")
    with user_session_for(user_a.id, bind=seeded_rules) as session:
        fix = record_user_label(session, user_id=user_a.id, transaction_id=txn, category="other")
    assert fix is not None
    assert (fix.rule_merchant_norm, fix.relabeled) == (None, 0)


def test_fixing_another_users_transaction_finds_nothing(
    seeded_rules: Connection, user_a: FixtureUser, user_b: FixtureUser, account: uuid.UUID
) -> None:
    txn = make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ BAKERY")
    with user_session_for(user_b.id, bind=seeded_rules) as session:
        assert (
            record_user_label(session, user_id=user_b.id, transaction_id=txn, category="dining")
            is None
        )


def test_unknown_categories_are_refused(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    txn = make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ BAKERY")
    with (
        user_session_for(user_a.id, bind=seeded_rules) as session,
        pytest.raises(ValueError, match="snacks"),
    ):
        record_user_label(session, user_id=user_a.id, transaction_id=txn, category="snacks")


# The job ------------------------------------------------------------------------


def test_categorize_run_job(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    seeded_rules.execute(text("DELETE FROM jobs"))
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ BAKERY")
    with user_session_for(user_a.id, bind=seeded_rules) as session:
        job_id = queue.enqueue(session, user_id=user_a.id, kind=JobKind.CATEGORIZE_RUN)
    labeler = SpyLabeler({"zz bakery": ("dining", 0.9)})
    worker = Worker(
        handlers=default_handlers(),
        services=Services(labeler=labeler),
        queue_bind=seeded_rules,
        user_bind=seeded_rules,
    )
    assert worker.run_once()
    status, result = seeded_rules.execute(
        text("SELECT status::text, result FROM jobs WHERE id = :id"), {"id": job_id}
    ).one()
    assert status == "succeeded"
    assert result["llm_labeled"] == 1
    assert labeler.job_ids == [job_id]


def test_without_a_model_the_rules_still_label_and_the_job_succeeds(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    """No ANTHROPIC_API_KEY (spec 003 rule 12a): rules and reuse run, the rest waits."""
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="SAFEWAY #1234")
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ LOCAL BAKERY 42")

    result = run(seeded_rules, user_a, None)

    found = labels(seeded_rules, user_a)
    assert found["safeway"] == [("groceries", "rule", None)]
    assert found["zz local bakery"] == [(None, None, None)]
    assert result == {
        "rule_labeled": 1,
        "reused": 0,
        "llm_labeled": 0,
        "unresolved": 1,
        "batches": 0,
        "stopped": "no_model",
    }


def test_the_worker_runs_categorize_without_a_labeler(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID
) -> None:
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="SAFEWAY #1234")
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="ZZ LOCAL BAKERY 42")
    seeded_rules.execute(text("DELETE FROM jobs"))
    with user_session_for(user_a.id, bind=seeded_rules) as session:
        job_id = queue.enqueue(session, user_id=user_a.id, kind=JobKind.CATEGORIZE_RUN, payload={})
    worker = Worker(
        handlers=default_handlers(),
        services=Services(labeler=None),
        queue_bind=seeded_rules,
        user_bind=seeded_rules,
    )
    assert worker.run_once()
    status, result = seeded_rules.execute(
        text("SELECT status::text, result FROM jobs WHERE id = :id"), {"id": job_id}
    ).one()
    assert status == "succeeded"
    assert result["stopped"] == "no_model"
    assert labels(seeded_rules, user_a)["safeway"] == [("groceries", "rule", None)]


@pytest.mark.parametrize("status", [401, 403, 404])
def test_a_rejected_key_or_model_stops_at_no_model_without_retrying(
    seeded_rules: Connection, user_a: FixtureUser, account: uuid.UUID, status: int
) -> None:
    """The API rejects the key, its permissions or the model id (spec 003 rule 12a).

    Retrying cannot fix configuration: the job keeps what the rules labeled,
    makes no further calls and succeeds as a worker with no model would.
    """
    make_transaction(seeded_rules, user_a.id, account, merchant_raw="SAFEWAY #1234")
    for name in shop_names(51):  # two batches
        make_transaction(seeded_rules, user_a.id, account, merchant_raw=name.upper())
    seeded_rules.execute(text("DELETE FROM jobs"))
    with user_session_for(user_a.id, bind=seeded_rules) as session:
        job_id = queue.enqueue(session, user_id=user_a.id, kind=JobKind.CATEGORIZE_RUN, payload={})
    api = ErroringApi(status)
    worker = Worker(
        handlers=default_handlers(),
        services=Services(labeler=api_gateway(seeded_rules, api)),
        queue_bind=seeded_rules,
        user_bind=seeded_rules,
    )
    assert worker.run_once()

    job_status, attempts, last_error, result = seeded_rules.execute(
        text("SELECT status::text, attempts, last_error, result FROM jobs WHERE id = :id"),
        {"id": job_id},
    ).one()
    assert (job_status, attempts, last_error) == ("succeeded", 1, None)
    assert result == {
        "rule_labeled": 1,
        "reused": 0,
        "llm_labeled": 0,
        "unresolved": 51,
        "batches": 1,
        "stopped": "no_model",
    }
    assert labels(seeded_rules, user_a)["safeway"] == [("groceries", "rule", None)]
    assert api.requests == 1
    statuses = seeded_rules.execute(
        text("SELECT status::text FROM llm_calls WHERE user_id = :u"), {"u": user_a.id}
    ).scalars()
    assert list(statuses) == ["api_error"]
