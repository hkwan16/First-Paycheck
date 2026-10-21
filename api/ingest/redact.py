"""Finding and removing identifiers before anything reaches a model (spec 004 rules 12, 14-18).

``find_sensitive`` scans page text for SSNs, EINs and account or routing
numbers. ``redact_text`` replaces each with ``[REDACTED]``; ``redact_image``
blacks out the word boxes under each match in a page image, so the vision
model keeps the layout and never sees the digits. A page whose OCR mean
confidence is below ``MIN_PAGE_CONFIDENCE`` cannot be redacted reliably (a
misread SSN does not match any pattern) and is withheld by the pipeline.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from PIL import Image, ImageDraw

from ingest.layout import Line, page_text

REDACTED = "[REDACTED]"
PADDING = 4
CONTEXT_CHARS = 60
MIN_PAGE_CONFIDENCE = 60

SensitiveKind = Literal["ssn", "ein", "account"]

__all__ = [
    "MIN_PAGE_CONFIDENCE",
    "PADDING",
    "REDACTED",
    "SensitiveKind",
    "Span",
    "find_sensitive",
    "is_readable",
    "redact_image",
    "redact_text",
]


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    kind: SensitiveKind


# A number must stand alone: nothing number-like or word-like touching it, so
# amounts (1,234.56), dates (2026-10-15) and longer runs never match in part.
_ALONE_BEFORE = r"(?<![\w.,-])"
_ALONE_AFTER = r"(?!\w)(?![.,-]\d)"


def _number(body: str) -> re.Pattern[str]:
    return re.compile(_ALONE_BEFORE + body + _ALONE_AFTER)


def _context(*words: str) -> re.Pattern[str]:
    alternatives = "|".join(words)
    return re.compile(rf"(?<![a-z0-9])(?:{alternatives})(?![a-z0-9])", re.IGNORECASE)


_SSN_CONTEXT = _context("ssn", "ss#", "social", r"soc\.? ?sec", "taxpayer id")
_ACCOUNT_CONTEXT = _context("acct", "account", "routing", "aba", "transit", "direct deposit")

# Scanned in this order; a later rule never matches inside an earlier span.
_RULES: tuple[tuple[SensitiveKind, re.Pattern[str], bool], ...] = (
    ("ssn", _number(r"\d{3}-\d{2}-\d{4}"), False),
    ("ein", _number(r"\d{2}-\d{7}"), False),
    ("ssn", _number(r"\d{3}[ -]?\d{2}[ -]?\d{4}"), True),
    ("account", _number(r"\d(?:-?\d){7,16}"), True),
)


def _last_end(pattern: re.Pattern[str], window: str) -> int:
    """Where the last match of ``pattern`` in ``window`` ends, or -1."""
    return max((match.end() for match in pattern.finditer(window)), default=-1)


def _has_context(kind: SensitiveKind, window: str) -> bool:
    """A nine-digit number is an SSN only when an SSN label is the nearest label
    before it; with an account label nearer, the account rule takes it."""
    ssn, account = _last_end(_SSN_CONTEXT, window), _last_end(_ACCOUNT_CONTEXT, window)
    if kind == "ssn":
        return ssn > account
    return account >= 0


def find_sensitive(text: str) -> list[Span]:
    """Non-overlapping spans of identifiers in ``text``, in text order."""
    spans: list[Span] = []
    for kind, pattern, needs_context in _RULES:
        for match in pattern.finditer(text):
            start, end = match.span()
            if any(start < span.end and span.start < end for span in spans):
                continue
            window = text[max(0, start - CONTEXT_CHARS) : start]
            if needs_context and not _has_context(kind, window):
                continue
            spans.append(Span(start, end, kind))
    return sorted(spans, key=lambda span: span.start)


def redact_text(text: str) -> tuple[str, int]:
    """``text`` with every identifier replaced by ``[REDACTED]``, and how many."""
    spans = find_sensitive(text)
    parts: list[str] = []
    position = 0
    for span in spans:
        parts.append(text[position : span.start])
        parts.append(REDACTED)
        position = span.end
    parts.append(text[position:])
    return "".join(parts), len(spans)


def redact_image(image: Image.Image, lines: Sequence[Line]) -> tuple[Image.Image, int]:
    """A copy of ``image`` with a black box over every word that overlaps an
    identifier, padded by ``PADDING`` pixels and clipped to the image."""
    text, words = page_text(lines)
    spans = find_sensitive(text)
    redacted = image.copy()
    if not spans:
        return redacted, 0
    draw = ImageDraw.Draw(redacted)
    width, height = redacted.size
    for span in spans:
        for start, end, word in words:
            if start < span.end and span.start < end:
                box = (
                    max(0, int(word.x0) - PADDING),
                    max(0, int(word.top) - PADDING),
                    min(width - 1, round(word.x1) + PADDING),
                    min(height - 1, round(word.bottom) + PADDING),
                )
                draw.rectangle(box, fill="black")
    return redacted, len(spans)


def is_readable(mean_confidence: float) -> bool:
    """Whether an OCR'd page is reliable enough to redact and send."""
    return mean_confidence >= MIN_PAGE_CONFIDENCE
