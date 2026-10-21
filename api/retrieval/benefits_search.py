"""Full-text search over the user's redacted benefits text (spec 008 rule 6).

``benefits_chunks.search`` is a stored ``to_tsvector('english', text)`` with a
GIN index. Each whitespace-separated word of the query goes through its own
``plainto_tsquery``, so user words are never parsed as tsquery syntax, and the
words are joined with ``||`` (OR): a chunk needs only one of them, and
``ts_rank`` puts chunks that match more of them first. ``plainto_tsquery`` of
the whole query would AND every word, and real plan text rarely holds
"401(k)", "retirement", "match" and "vesting" in one chunk. Rows are filtered
by RLS and by ``user_id``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from functools import reduce
from typing import Any

from sqlalchemy import ColumnElement, cast, func, literal, select
from sqlalchemy.dialects.postgresql import REGCONFIG
from sqlalchemy.orm import Session

from db.models import BenefitsChunk

__all__ = ["BenefitsPassage", "search"]


@dataclass(frozen=True)
class BenefitsPassage:
    document_id: uuid.UUID
    chunk_index: int
    text: str
    # ts_rank's relevance score; only its order matters.
    rank: float


def _any_word(query: str) -> ColumnElement[Any]:
    english = cast(literal("english"), REGCONFIG)
    words = [func.plainto_tsquery(english, word) for word in query.split()]
    return reduce(lambda left, right: left.op("||")(right), words)


def search(session: Session, user_id: uuid.UUID, query: str, k: int) -> list[BenefitsPassage]:
    """The ``k`` chunks that best match ``query``, best first."""
    if k <= 0 or not query.strip():
        return []
    tsquery = _any_word(query)
    rank = func.ts_rank(BenefitsChunk.search, tsquery).label("rank")
    rows = session.execute(
        select(BenefitsChunk.document_id, BenefitsChunk.chunk_index, BenefitsChunk.text, rank)
        .where(BenefitsChunk.user_id == user_id, BenefitsChunk.search.op("@@")(tsquery))
        .order_by(rank.desc(), BenefitsChunk.document_id, BenefitsChunk.chunk_index)
        .limit(k)
    )
    return [
        BenefitsPassage(
            document_id=row.document_id,
            chunk_index=row.chunk_index,
            text=row.text,
            rank=float(row.rank),
        )
        for row in rows
    ]
