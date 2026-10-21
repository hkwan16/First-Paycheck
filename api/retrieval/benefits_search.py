"""Full-text search over the user's redacted benefits text (spec 008 rule 6).

``benefits_chunks.search`` is a stored ``to_tsvector('english', text)`` with a
GIN index; the query goes through ``plainto_tsquery``, so user words are never
parsed as tsquery syntax. Rows are filtered by RLS and by ``user_id``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

__all__ = ["BenefitsPassage", "search"]

_SEARCH = text(
    """
    SELECT chunk.document_id, chunk.chunk_index, chunk.text, ts_rank(chunk.search, query) AS rank
    FROM benefits_chunks AS chunk, plainto_tsquery('english', :query) AS query
    WHERE chunk.user_id = :user_id AND chunk.search @@ query
    ORDER BY rank DESC, chunk.document_id, chunk.chunk_index
    LIMIT :k
    """
)


@dataclass(frozen=True)
class BenefitsPassage:
    document_id: uuid.UUID
    chunk_index: int
    text: str
    # ts_rank's relevance score; only its order matters.
    rank: float


def search(session: Session, user_id: uuid.UUID, query: str, k: int) -> list[BenefitsPassage]:
    """The ``k`` chunks that best match ``query``, best first."""
    if k <= 0 or not query.strip():
        return []
    rows = session.execute(_SEARCH, {"query": query, "user_id": user_id, "k": k})
    return [
        BenefitsPassage(
            document_id=row.document_id,
            chunk_index=row.chunk_index,
            text=row.text,
            rank=float(row.rank),
        )
        for row in rows
    ]
