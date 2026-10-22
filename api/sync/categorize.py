"""Transaction categorization (spec 003).

Plain-string rules first, in a fixed precedence (user exact, user prefix,
seed exact, seed prefix); only merchants no rule knows go to the LLM gateway,
50 per call. A user's correction becomes a user exact rule and relabels the
same merchant's other transactions.
"""

from __future__ import annotations

import datetime as dt
import re
import unicodedata
import uuid
from collections import defaultdict
from collections.abc import Callable, Iterable, Iterator, Sequence
from contextlib import AbstractContextManager
from dataclasses import asdict, dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal, Protocol

from sqlalchemy import func, or_, select, update
from sqlalchemy.dialects.postgresql import distinct_on, insert
from sqlalchemy.orm import Session

from db.enums import CategorySource, RuleMatch, RuleSource
from db.models import CategoryRule as CategoryRuleRow
from db.models import Transaction
from llm.gateway import CategorizeItem, LLMBudgetExceeded, LLMMisconfigured, LLMRefused
from llm.schemas import CategoryBatch
from sync.categories import CATEGORIES

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


@dataclass(frozen=True)
class CategoryRule:
    merchant_norm: str
    match: RuleMatch
    category: str
    source: RuleSource


class RuleBook:
    """The rules one user sees (their own plus the seed rows), indexed for
    hash lookups: one exact lookup and one lookup per whole-token prefix."""

    def __init__(self, rules: Iterable[CategoryRule]) -> None:
        self._index: dict[tuple[RuleSource, RuleMatch], dict[str, CategoryRule]] = {
            (source, match): {} for source in RuleSource for match in RuleMatch
        }
        for rule in rules:
            if rule.category not in CATEGORIES:
                raise ValueError(
                    f"rule {rule.merchant_norm!r} has unknown category {rule.category!r}"
                )
            self._index[(rule.source, rule.match)][rule.merchant_norm] = rule

    def match(self, merchant_norm: str) -> CategoryRule | None:
        if not merchant_norm:
            return None
        for source in (RuleSource.USER, RuleSource.SEED):
            exact = self._index[(source, RuleMatch.EXACT)].get(merchant_norm)
            if exact is not None:
                return exact
            prefixes = self._index[(source, RuleMatch.PREFIX)]
            for prefix in token_prefixes(merchant_norm):
                found = prefixes.get(prefix)
                if found is not None:
                    return found
        return None


def apply_rules(merchant_norm: str, rules: RuleBook) -> CategoryRule | None:
    """The rule that decides ``merchant_norm``'s category, or None for the LLM."""
    return rules.match(merchant_norm)


# The categorize job (rules 6-12) --------------------------------------------------

Sessions = Callable[[], AbstractContextManager[Session]]


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
        samples = _samples(session, user_id, sorted(unknown - resolved))

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
) -> set[str]:
    """Label what the rules decide; return the non-empty merchants they do not."""
    pending = session.execute(
        select(Transaction.id, Transaction.merchant_norm).where(
            Transaction.user_id == user_id, Transaction.category.is_(None)
        )
    )
    by_category: dict[str, list[uuid.UUID]] = defaultdict(list)
    unknown: set[str] = set()
    for txn_id, merchant_norm in pending:
        rule = rules.match(merchant_norm)
        if rule is not None:
            by_category[rule.category].append(txn_id)
        elif merchant_norm:
            unknown.add(merchant_norm)
    for category, ids in by_category.items():
        session.execute(
            update(Transaction)
            .where(Transaction.id.in_(ids))
            .values(category=category, category_source=CategorySource.RULE, confidence=None)
        )
        result.rule_labeled += len(ids)
    return unknown


def _reuse_llm_labels(
    session: Session, user_id: uuid.UUID, merchants: set[str]
) -> tuple[int, set[str]]:
    """Copy each merchant's newest LLM label to its uncategorized transactions."""
    if not merchants:
        return 0, set()
    previous = session.execute(
        select(Transaction.merchant_norm, Transaction.category, Transaction.confidence)
        .where(
            Transaction.user_id == user_id,
            Transaction.category_source == CategorySource.LLM,
            Transaction.merchant_norm.in_(merchants),
        )
        .order_by(Transaction.merchant_norm, Transaction.updated_at.desc(), Transaction.id.desc())
        .ext(distinct_on(Transaction.merchant_norm))
    ).all()
    reused = 0
    for merchant_norm, category, confidence in previous:
        reused += _label_uncategorized(
            session, user_id, merchant_norm, category, CategorySource.LLM, confidence
        )
    return reused, {row.merchant_norm for row in previous}


def _samples(session: Session, user_id: uuid.UUID, merchants: list[str]) -> list[_Sample]:
    """Each merchant's newest uncategorized transaction, in merchant order."""
    if not merchants:
        return []
    rows = session.execute(
        select(Transaction.merchant_norm, Transaction.amount_cents, Transaction.posted_at)
        .where(
            Transaction.user_id == user_id,
            Transaction.category.is_(None),
            Transaction.merchant_norm.in_(merchants),
        )
        .order_by(Transaction.merchant_norm, Transaction.posted_at.desc(), Transaction.id.desc())
        .ext(distinct_on(Transaction.merchant_norm))
    )
    return sorted((_Sample(*row) for row in rows), key=lambda sample: sample.merchant_norm)


def _write_llm_labels(
    session: Session,
    user_id: uuid.UUID,
    items: Sequence[CategorizeItem],
    answer: CategoryBatch,
) -> int:
    merchants = {item.id: item.merchant for item in items}
    labeled = 0
    for assignment in answer.items:
        merchant_norm = merchants.get(assignment.id)
        if merchant_norm is None:
            continue
        confidence = Decimal(str(assignment.confidence)).quantize(
            CONFIDENCE_STEP, rounding=ROUND_HALF_UP
        )
        labeled += _label_uncategorized(
            session, user_id, merchant_norm, assignment.category, CategorySource.LLM, confidence
        )
    return labeled


def _label_uncategorized(
    session: Session,
    user_id: uuid.UUID,
    merchant_norm: str,
    category: str | None,
    source: CategorySource,
    confidence: Decimal | None,
) -> int:
    updated = session.execute(
        update(Transaction)
        .where(
            Transaction.user_id == user_id,
            Transaction.merchant_norm == merchant_norm,
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
    siblings = session.execute(
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
    relabeled = len(siblings.all())
    session.flush()
    return UserLabel(transaction=txn, rule_merchant_norm=txn.merchant_norm, relabeled=relabeled)
