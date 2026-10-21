"""Words, lines and page text: the shape every reader produces (spec 004 rule 13).

A ``Word`` has a box in the page's own units (PDF points for text layers,
pixels for OCR). ``page_text`` joins lines with ``\\n`` and words with one
space and remembers where each word sits in that text, so a match found in
the text can be traced back to the boxes to black out.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

__all__ = ["Line", "Word", "WordSpan", "group_by_overlap", "page_text"]


@dataclass(frozen=True)
class Word:
    text: str
    x0: float
    top: float
    x1: float
    bottom: float
    # OCR confidence 0-100; None for text-layer words.
    conf: float | None = None

    @property
    def middle(self) -> float:
        return (self.top + self.bottom) / 2


@dataclass(frozen=True)
class Line:
    words: tuple[Word, ...]

    @property
    def text(self) -> str:
        return " ".join(word.text for word in self.words)


# (start, end, word): the word's characters in the page text, end exclusive.
WordSpan = tuple[int, int, Word]


def page_text(lines: Sequence[Line]) -> tuple[str, list[WordSpan]]:
    parts: list[str] = []
    spans: list[WordSpan] = []
    position = 0
    for line_number, line in enumerate(lines):
        if line_number:
            parts.append("\n")
            position += 1
        for word_number, word in enumerate(line.words):
            if word_number:
                parts.append(" ")
                position += 1
            spans.append((position, position + len(word.text), word))
            parts.append(word.text)
            position += len(word.text)
    return "".join(parts), spans


def group_by_overlap(words: Iterable[Word]) -> list[Line]:
    """Lines from loose words: a word joins the first line whose vertical extent
    contains its middle; lines run top to bottom and words left to right."""
    rows: list[tuple[float, float, list[Word]]] = []
    for word in sorted(words, key=lambda item: (item.top, item.x0)):
        for index, (top, bottom, members) in enumerate(rows):
            if top <= word.middle <= bottom:
                members.append(word)
                rows[index] = (min(top, word.top), max(bottom, word.bottom), members)
                break
        else:
            rows.append((word.top, word.bottom, [word]))
    rows.sort(key=lambda row: row[0])
    return [Line(tuple(sorted(members, key=lambda item: item.x0))) for _, _, members in rows]
