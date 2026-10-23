"""Transaction categorization (spec 003).

Plain-string rules first, in a fixed precedence (user exact, user prefix,
seed exact, seed prefix, seed contains); only merchants no rule knows go to the
LLM gateway, 50 per call. A rule for a spending category labels money out only
(rule 3b), so a paycheck from an employer named like a restaurant is never
dining; the model labels a merchant's money out and money in separately. A
user's correction becomes a user exact rule and relabels the same merchant's
other transactions that the rule applies to.
"""

from __future__ import annotations

import datetime as dt
import logging
import re
import unicodedata
import uuid
from collections import defaultdict
from collections.abc import Callable, Iterable, Iterator, Sequence
from contextlib import AbstractContextManager
from dataclasses import asdict, dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal, Protocol

from sqlalchemy import ColumnElement, func, literal_column, or_, select, update
from sqlalchemy.dialects.postgresql import distinct_on, insert
from sqlalchemy.orm import Session

from db.enums import CategorySource, RuleMatch, RuleSource
from db.models import CategoryRule as CategoryRuleRow
from db.models import Transaction
from llm.gateway import CategorizeItem, LLMBudgetExceeded, LLMMisconfigured, LLMRefused
from llm.schemas import CategoryBatch
from sync.categories import CATEGORIES, MONEY_IN_CATEGORIES, allowed_for, is_money_in

logger = logging.getLogger(__name__)

MAX_MERCHANT_NORM = 128
BATCH_SIZE = 50
CONFIDENCE_STEP = Decimal("0.001")
PROCESSOR_PREFIXES = frozenset({"sq", "tst", "pp", "sp", "pos", "checkcard"})
_APOSTROPHES = str.maketrans("", "", "'\N{RIGHT SINGLE QUOTATION MARK}")
# Token characters: letters and digits (Unicode \w without "_"), "." and "&".
_SEPARATORS = re.compile(r"[^\w.&]+|_")
_DIGIT = re.compile(r"\d")


def normalize_merchant(raw: str) -> str:
    """The rule-matching key for a merchant description (spec 003 rule 1)."""
    text = unicodedata.normalize("NFKC", raw).lower().translate(_APOSTROPHES)
    tokens = [token.strip(".") for token in _SEPARATORS.split(text) if not _DIGIT.search(token)]
    tokens = [token for token in tokens if token]
    while len(tokens) > 1 and tokens[0] in PROCESSOR_PREFIXES:
        tokens.pop(0)
    return " ".join(tokens)[:MAX_MERCHANT_NORM].rstrip()


def token_prefixes(merchant_norm: str) -> Iterator[str]:
    """Every whole-token prefix of ``merchant_norm``, longest first."""
    tokens = merchant_norm.split(" ") if merchant_norm else []
    for end in range(len(tokens), 0, -1):
        yield " ".join(tokens[:end])


def token_runs(merchant_norm: str) -> Iterator[str]:
    """Every run of whole tokens in ``merchant_norm``: longest first, then
    leftmost first (the order ``contains`` rules are tried, spec 003 rule 4)."""
    tokens = merchant_norm.split(" ") if merchant_norm else []
    for size in range(len(tokens), 0, -1):
        for start in range(len(tokens) - size + 1):
            yield " ".join(tokens[start : start + size])


@dataclass(frozen=True)
class CategoryRule:
    merchant_norm: str
    match: RuleMatch
    category: str
    source: RuleSource


def check_contains(rule: CategoryRule) -> str | None:
    """Why ``rule`` may not be a ``contains`` rule, or None (spec 003 rule 3c)."""
    if rule.match is not RuleMatch.CONTAINS:
        return None
    if rule.source is not RuleSource.SEED or rule.category not in MONEY_IN_CATEGORIES:
        return "contains is only for seed income and transfer rules"
    return None


class RuleBook:
    """The rules one user sees (their own plus the seed rows), indexed for
    hash lookups: one exact lookup, one per whole-token prefix and, for money
    in, one per run of whole tokens."""

    def __init__(self, rules: Iterable[CategoryRule]) -> None:
        self._index: dict[tuple[RuleSource, RuleMatch], dict[str, CategoryRule]] = {
            (source, match): {} for source in RuleSource for match in RuleMatch
        }
        for rule in rules:
            if rule.category not in CATEGORIES:
                raise ValueError(
                    f"rule {rule.merchant_norm!r} has unknown category {rule.category!r}"
                )
            problem = check_contains(rule)
            if problem is not None:
                raise ValueError(f"rule {rule.merchant_norm!r}: {problem}")
            self._index[(rule.source, rule.match)][rule.merchant_norm] = rule

    def match(self, merchant_norm: str, *, amount_cents: int) -> CategoryRule | None:
        """The rule that decides a transaction's category (spec 003 rules 3-5).

        A rule that does not apply to the transaction's direction (a spending
        rule for money in) is skipped as if it did not exist.
        """
        if not merchant_norm:
            return None
        for source in (RuleSource.USER, RuleSource.SEED):
            exact = self._index[(source, RuleMatch.EXACT)].get(merchant_norm)
            if exact is not None and allowed_for(exact.category, amount_cents):
                return exact
            prefixes = self._index[(source, RuleMatch.PREFIX)]
            for prefix in token_prefixes(merchant_norm):
                found = prefixes.get(prefix)
                if found is not None and allowed_for(found.category, amount_cents):
                    return found
        if is_money_in(amount_cents):
            contains = self._index[(RuleSource.SEED, RuleMatch.CONTAINS)]
            for run in token_runs(merchant_norm):
                found = contains.get(run)
                if found is not None:
                    return found
        return None


def apply_rules(merchant_norm: str, rules: RuleBook, *, amount_cents: int) -> CategoryRule | None:
    """The rule that decides a transaction's category, or None for the LLM."""
    return rules.match(merchant_norm, amount_cents=amount_cents)


# The categorize job (rules 6-12) --------------------------------------------------

Sessions = Callable[[], AbstractContextManager[Session]]
# What the model labels: a merchant and a direction (True for money in), rule 8.
Unit = tuple[str, bool]
# ``amount_cents < 0`` with a literal zero, so DISTINCT ON and ORDER BY render
# the same expression (a bound parameter would differ between the two).
_MONEY_IN = Transaction.amount_cents < literal_column("0")


def _direction(money_in: bool) -> ColumnElement[bool]:
    return _MONEY_IN if money_in else Transaction.amount_cents >= literal_column("0")


class CategoryLabeler(Protocol):
    """What the job needs from the LLM gateway."""

    def categorize(
        self,
        user_id: uuid.UUID,
        items: Sequence[CategorizeItem],
        *,
        job_id: uuid.UUID | None = None,
    ) -> CategoryBatch: ...


@dataclass
class CategorizeResult:
    """Counts of transactions, except ``batches`` (gateway calls attempted)."""

    rule_labeled: int = 0
    reused: int = 0
    llm_labeled: int = 0
    unresolved: int = 0
    batches: int = 0
    stopped: Literal["budget", "refused", "no_model"] | None = None

    def as_job_result(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class _Sample:
    merchant_norm: str
    money_in: bool
    amount_cents: int
    posted_at: dt.date


def load_rulebook(session: Session) -> RuleBook:
    """The user's rules plus the seed rows: exactly what RLS lets them read."""
    rows = session.execute(
        select(
            CategoryRuleRow.merchant_norm,
            CategoryRuleRow.match,
            CategoryRuleRow.category,
            CategoryRuleRow.source,
        )
    )
    return RuleBook(CategoryRule(*row) for row in rows)


def categorize_user(
    *,
    user_id: uuid.UUID,
    sessions: Sessions,
    labeler: CategoryLabeler | None,
    job_id: uuid.UUID | None = None,
    progress: Callable[[int], None] | None = None,
) -> CategorizeResult:
    """Label the user's uncategorized transactions: rules, reuse, then the LLM.

    Without a labeler (no gateway configured, spec 003 rule 12a), or once the
    API rejects the key or the model id, the rules and reuse steps still count
    and the unknown merchants wait for a later run.

    No database transaction is open while the gateway is called; each batch's
    labels are written in their own short session, so a later failure keeps
    the batches already written.
    """
    result = CategorizeResult()
    with sessions() as session:
        unknown = _apply_rules(session, user_id, load_rulebook(session), result)
        result.reused, resolved = _reuse_llm_labels(session, user_id, unknown)
        samples = _samples(session, user_id, unknown - resolved)

    batches = [samples[start : start + BATCH_SIZE] for start in range(0, len(samples), BATCH_SIZE)]
    for done, batch in enumerate(batches, start=1):
        items = [
            CategorizeItem(
                id=index,
                merchant=sample.merchant_norm,
                amount_cents=sample.amount_cents,
                date=sample.posted_at,
            )
            for index, sample in enumerate(batch, start=1)
        ]
        if labeler is None:
            result.stopped = "no_model"
            break
        result.batches += 1
        try:
            answer = labeler.categorize(user_id, items, job_id=job_id)
        except LLMBudgetExceeded:
            result.stopped = "budget"
            break
        except LLMMisconfigured:
            # The API rejected the key or the model id: as if there were no
            # model (rule 12a), since no retry can fix it.
            result.stopped = "no_model"
            break
        except LLMRefused:
            result.stopped = "refused"
            continue
        with sessions() as session:
            result.llm_labeled += _write_llm_labels(session, user_id, items, answer)
        if progress is not None:
            progress(min(99, round(100 * done / len(batches))))

    with sessions() as session:
        unresolved = session.scalar(
            select(func.count())
            .select_from(Transaction)
            .where(Transaction.user_id == user_id, Transaction.category.is_(None))
        )
    result.unresolved = unresolved or 0
    return result


def _apply_rules(
    session: Session, user_id: uuid.UUID, rules: RuleBook, result: CategorizeResult
) -> set[Unit]:
    """Label what the rules decide; return the non-empty merchants and
    directions they do not."""
    pending = session.execute(
        select(Transaction.id, Transaction.merchant_norm, Transaction.amount_cents).where(
            Transaction.user_id == user_id, Transaction.category.is_(None)
        )
    )
    by_category: dict[str, list[uuid.UUID]] = defaultdict(list)
    unknown: set[Unit] = set()
    for txn_id, merchant_norm, amount_cents in pending:
        rule = rules.match(merchant_norm, amount_cents=amount_cents)
        if rule is not None:
            by_category[rule.category].append(txn_id)
        elif merchant_norm:
            unknown.add((merchant_norm, is_money_in(amount_cents)))
    for category, ids in by_category.items():
        session.execute(
            update(Transaction)
            .where(Transaction.id.in_(ids))
            .values(category=category, category_source=CategorySource.RULE, confidence=None)
        )
        result.rule_labeled += len(ids)
    return unknown


def _reuse_llm_labels(
    session: Session, user_id: uuid.UUID, units: set[Unit]
) -> tuple[int, set[Unit]]:
    """Copy each merchant and direction's newest LLM label to its uncategorized
    transactions, when the label is allowed for the direction (rule 8)."""
    if not units:
        return 0, set()
    previous = session.execute(
        select(
            Transaction.merchant_norm,
            _MONEY_IN.label("money_in"),
            Transaction.category,
            Transaction.confidence,
        )
        .where(
            Transaction.user_id == user_id,
            Transaction.category_source == CategorySource.LLM,
            Transaction.merchant_norm.in_({merchant for merchant, _ in units}),
            # A money-in row the model labeled with a spending category before
            # rule 10 is not a label to copy.
            or_(~_MONEY_IN, Transaction.category.in_(MONEY_IN_CATEGORIES)),
        )
        .order_by(
            Transaction.merchant_norm,
            _MONEY_IN,
            Transaction.updated_at.desc(),
            Transaction.id.desc(),
        )
        .ext(distinct_on(Transaction.merchant_norm, _MONEY_IN))
    ).all()
    reused = 0
    resolved: set[Unit] = set()
    for merchant_norm, money_in, category, confidence in previous:
        if (merchant_norm, money_in) not in units:
            continue
        resolved.add((merchant_norm, money_in))
        reused += _label_uncategorized(
            session, user_id, (merchant_norm, money_in), category, CategorySource.LLM, confidence
        )
    return reused, resolved


def _samples(session: Session, user_id: uuid.UUID, units: set[Unit]) -> list[_Sample]:
    """Each unit's newest uncategorized transaction, by merchant, money out first."""
    if not units:
        return []
    rows = session.execute(
        select(
            Transaction.merchant_norm,
            _MONEY_IN.label("money_in"),
            Transaction.amount_cents,
            Transaction.posted_at,
        )
        .where(
            Transaction.user_id == user_id,
            Transaction.category.is_(None),
            Transaction.merchant_norm.in_({merchant for merchant, _ in units}),
        )
        .order_by(
            Transaction.merchant_norm,
            _MONEY_IN,
            Transaction.posted_at.desc(),
            Transaction.id.desc(),
        )
        .ext(distinct_on(Transaction.merchant_norm, _MONEY_IN))
    )
    samples = [_Sample(*row) for row in rows if (row.merchant_norm, row.money_in) in units]
    return sorted(samples, key=lambda sample: (sample.merchant_norm, sample.money_in))


def _write_llm_labels(
    session: Session,
    user_id: uuid.UUID,
    items: Sequence[CategorizeItem],
    answer: CategoryBatch,
) -> int:
    by_id = {item.id: item for item in items}
    labeled = dropped = 0
    for assignment in answer.items:
        item = by_id.get(assignment.id)
        if item is None:
            continue
        if not allowed_for(assignment.category, item.amount_cents):
            # Rule 10: a money-in item never gets a spending category.
            dropped += 1
            continue
        confidence = Decimal(str(assignment.confidence)).quantize(
            CONFIDENCE_STEP, rounding=ROUND_HALF_UP
        )
        labeled += _label_uncategorized(
            session,
            user_id,
            (item.merchant, is_money_in(item.amount_cents)),
            assignment.category,
            CategorySource.LLM,
            confidence,
        )
    if dropped:
        logger.info(
            "dropped spending labels the model gave money-in items", extra={"dropped": dropped}
        )
    return labeled


def _label_uncategorized(
    session: Session,
    user_id: uuid.UUID,
    unit: Unit,
    category: str | None,
    source: CategorySource,
    confidence: Decimal | None,
) -> int:
    merchant_norm, money_in = unit
    updated = session.execute(
        update(Transaction)
        .where(
            Transaction.user_id == user_id,
            Transaction.merchant_norm == merchant_norm,
            _direction(money_in),
            Transaction.category.is_(None),
        )
        .values(category=category, category_source=source, confidence=confidence)
        .returning(Transaction.id)
    )
    return len(updated.all())


# User corrections (rules 13-16) ------------------------------------------------------


@dataclass(frozen=True)
class UserLabel:
    transaction: Transaction
    # The merchant of the user exact rule written, or None for an empty merchant.
    rule_merchant_norm: str | None
    relabeled: int


def record_user_label(
    session: Session, *, user_id: uuid.UUID, transaction_id: uuid.UUID, category: str
) -> UserLabel | None:
    """Apply a user's category to one transaction, its rule and its siblings.

    The transaction keeps the user's category whatever its direction (rule 13);
    the siblings relabeled are the ones the new rule applies to (rule 15), so a
    spending category never relabels the merchant's money in.

    Returns None when the transaction does not exist for this user (RLS hides
    other users' rows), so the route answers 404.
    """
    if category not in CATEGORIES:
        raise ValueError(f"unknown category {category!r}")
    txn = session.scalar(
        select(Transaction).where(Transaction.id == transaction_id, Transaction.user_id == user_id)
    )
    if txn is None:
        return None
    txn.category = category
    txn.category_source = CategorySource.USER
    txn.confidence = None
    if not txn.merchant_norm:
        session.flush()
        return UserLabel(transaction=txn, rule_merchant_norm=None, relabeled=0)

    rule = insert(CategoryRuleRow).values(
        user_id=user_id,
        merchant_norm=txn.merchant_norm,
        match=RuleMatch.EXACT,
        category=category,
        source=RuleSource.USER,
    )
    session.execute(
        rule.on_conflict_do_update(
            constraint="uq_category_rules_user_id_merchant_norm_match",
            set_={"category": rule.excluded.category},
        )
    )
    siblings = (
        update(Transaction)
        .where(
            Transaction.user_id == user_id,
            Transaction.merchant_norm == txn.merchant_norm,
            Transaction.id != txn.id,
            or_(
                Transaction.category_source.is_(None),
                Transaction.category_source != CategorySource.USER,
            ),
        )
        .values(category=category, category_source=CategorySource.RULE, confidence=None)
        .returning(Transaction.id)
        .execution_options(synchronize_session=False)
    )
    if category not in MONEY_IN_CATEGORIES:
        siblings = siblings.where(_direction(money_in=False))
    relabeled = len(session.execute(siblings).all())
    session.flush()
    return UserLabel(transaction=txn, rule_merchant_norm=txn.merchant_norm, relabeled=relabeled)
