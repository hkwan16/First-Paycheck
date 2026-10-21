"""Benefits text in overlapping word windows for full-text retrieval (spec 004 rule 19)."""

from __future__ import annotations

CHUNK_WORDS = 400
CHUNK_OVERLAP = 50

__all__ = ["CHUNK_OVERLAP", "CHUNK_WORDS", "chunk_words"]


def chunk_words(text: str, *, size: int = CHUNK_WORDS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Chunks of up to ``size`` words; each starts ``size - overlap`` words after
    the previous one, and the last is the first that reaches the final word."""
    if size < 1:
        raise ValueError("size must be at least 1")
    if not 0 <= overlap < size:
        raise ValueError("overlap must be at least 0 and smaller than size")
    tokens = text.split()
    chunks: list[str] = []
    start = 0
    while start < len(tokens):
        end = min(start + size, len(tokens))
        chunks.append(" ".join(tokens[start:end]))
        if end == len(tokens):
            break
        start += size - overlap
    return chunks
