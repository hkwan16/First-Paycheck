"""Retrieval chunks (spec 004 rule 19 and the chunking examples)."""

from __future__ import annotations

import pytest

from ingest.chunk import CHUNK_OVERLAP, CHUNK_WORDS, chunk_words


def words(count: int) -> str:
    return " ".join(f"w{i}" for i in range(count))


def ranges(text: str) -> list[tuple[int, int]]:
    found = []
    for chunk in chunk_words(text):
        tokens = chunk.split(" ")
        found.append((int(tokens[0][1:]), int(tokens[-1][1:]) + 1))
    return found


@pytest.mark.parametrize(
    ("count", "expected"),
    [
        (0, []),
        (10, [(0, 10)]),
        (400, [(0, 400)]),
        (401, [(0, 400), (350, 401)]),
        (1000, [(0, 400), (350, 750), (700, 1000)]),
    ],
)
def test_chunk_ranges(count: int, expected: list[tuple[int, int]]) -> None:
    assert ranges(words(count)) == expected


def test_defaults_match_the_spec() -> None:
    assert (CHUNK_WORDS, CHUNK_OVERLAP) == (400, 50)


def test_whitespace_is_normalized() -> None:
    assert chunk_words("  Deductible\n\tapplies   first \n") == ["Deductible applies first"]


def test_custom_sizes_and_bad_arguments() -> None:
    assert chunk_words("a b c d e", size=2, overlap=1) == ["a b", "b c", "c d", "d e"]
    with pytest.raises(ValueError, match="overlap"):
        chunk_words("a b", size=2, overlap=2)
    with pytest.raises(ValueError, match="size"):
        chunk_words("a b", size=0, overlap=0)
