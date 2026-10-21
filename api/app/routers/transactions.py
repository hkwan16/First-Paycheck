"""Transactions: filtered, cursor-paginated reads and category corrections (spec 003)."""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import or_, select, tuple_

from app.auth import CurrentUser
from app.deps import UserSession
from app.errors import AppError, NotFound, error_responses
from db.enums import CategorySource
from db.models import Transaction
from sync.categories import Category
from sync.categorize import record_user_label

router = APIRouter(prefix="/transactions", tags=["transactions"])

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


class TransactionOut(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    posted_at: dt.date
    # > 0 is money out (Plaid's sign convention).
    amount_cents: int
    merchant_raw: str
    merchant_clean: str | None
    merchant_norm: str
    category: Category | None
    category_source: CategorySource | None
    # Only for LLM labels: the model's self-reported confidence, 0 to 1.
    confidence: float | None
    pending: bool


class TransactionPage(BaseModel):
    items: list[TransactionOut]
    # Pass back as ``cursor`` for the next page; null on the last page.
    next_cursor: str | None


class CategoryPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: Category


class RuleOut(BaseModel):
    merchant_norm: str
    category: Category


class CategoryFix(BaseModel):
    transaction: TransactionOut
    # The user exact rule now labeling this merchant; null for an empty merchant.
    rule: RuleOut | None
    # How many of the user's other transactions were relabeled.
    relabeled: int


def _out(txn: Transaction) -> TransactionOut:
    return TransactionOut(
        id=txn.id,
        account_id=txn.account_id,
        posted_at=txn.posted_at,
        amount_cents=txn.amount_cents,
        merchant_raw=txn.merchant_raw,
        merchant_clean=txn.merchant_clean,
        merchant_norm=txn.merchant_norm,
        category=txn.category,  # type: ignore[arg-type]  # the column holds Category values
        category_source=txn.category_source,
        confidence=None if txn.confidence is None else float(txn.confidence),
        pending=txn.pending,
    )


def _invalid(message: str) -> AppError:
    return AppError(message, code="validation_error", status_code=422)


def encode_cursor(posted_at: dt.date, txn_id: uuid.UUID) -> str:
    raw = json.dumps([posted_at.isoformat(), str(txn_id)]).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[dt.date, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        posted_at, txn_id = json.loads(raw)
        return dt.date.fromisoformat(posted_at), uuid.UUID(txn_id)
    except (binascii.Error, ValueError, TypeError):
        raise _invalid("cursor: not a cursor returned by this endpoint") from None


@router.get("", responses=error_responses(401, 422))
def list_transactions(
    user: CurrentUser,
    session: UserSession,
    account_id: uuid.UUID | None = None,
    start: Annotated[dt.date | None, Query(description="Earliest posted_at, inclusive")] = None,
    end: Annotated[dt.date | None, Query(description="Latest posted_at, inclusive")] = None,
    category: Category | None = None,
    min_confidence: Annotated[
        float | None,
        Query(ge=0, le=1, description="Rule and user labels count as 1; uncategorized excluded"),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> TransactionPage:
    """The user's transactions, newest first (posted_at, then id, descending)."""
    if start is not None and end is not None and start > end:
        raise _invalid("start: must not be after end")
    query = select(Transaction).where(Transaction.user_id == user.id)
    if account_id is not None:
        query = query.where(Transaction.account_id == account_id)
    if start is not None:
        query = query.where(Transaction.posted_at >= start)
    if end is not None:
        query = query.where(Transaction.posted_at <= end)
    if category is not None:
        query = query.where(Transaction.category == category)
    if min_confidence is not None:
        query = query.where(
            Transaction.category.is_not(None),
            or_(
                Transaction.category_source.in_([CategorySource.RULE, CategorySource.USER]),
                Transaction.confidence >= min_confidence,
            ),
        )
    if cursor is not None:
        after_posted, after_id = decode_cursor(cursor)
        query = query.where(
            tuple_(Transaction.posted_at, Transaction.id) < tuple_(after_posted, after_id)
        )
    rows = list(
        session.scalars(
            query.order_by(Transaction.posted_at.desc(), Transaction.id.desc()).limit(limit + 1)
        )
    )
    page, more = rows[:limit], len(rows) > limit
    next_cursor = encode_cursor(page[-1].posted_at, page[-1].id) if more else None
    return TransactionPage(items=[_out(txn) for txn in page], next_cursor=next_cursor)


@router.patch("/{transaction_id}", responses=error_responses(401, 404, 422))
def update_transaction_category(
    transaction_id: uuid.UUID, body: CategoryPatch, user: CurrentUser, session: UserSession
) -> CategoryFix:
    """Correct a transaction's category. The fix becomes the user's rule for
    that merchant and relabels the merchant's other transactions, except
    ones the user labeled individually."""
    fix = record_user_label(
        session, user_id=user.id, transaction_id=transaction_id, category=body.category
    )
    if fix is None:
        raise NotFound("Transaction not found")
    rule = (
        None
        if fix.rule_merchant_norm is None
        else RuleOut(merchant_norm=fix.rule_merchant_norm, category=body.category)
    )
    return CategoryFix(transaction=_out(fix.transaction), rule=rule, relabeled=fix.relabeled)
