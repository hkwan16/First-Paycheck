"""Redaction (spec 004 rules 13-18): the pattern table, image redaction, and the
low-confidence rule that keeps unreadable pages away from the model."""

from __future__ import annotations

import re

import pytest
from PIL import Image

from ingest.layout import Line, Word
from ingest.ocr import ocr_image
from ingest.redact import (
    MIN_PAGE_CONFIDENCE,
    REDACTED,
    Span,
    find_sensitive,
    is_readable,
    redact_image,
    redact_text,
)
from tests.support.documents import ACME_ACCOUNT, ACME_STUB_LINES, render_page

# Spec 004, hand-worked examples: redaction.
TABLE = [
    ("SSN 123-45-6789", "SSN [REDACTED]", 1),
    ("Employee ID 123-45-6789", "Employee ID [REDACTED]", 1),
    ("Social Security Number: 900123456", "Social Security Number: [REDACTED]", 1),
    ("SSN\n900 12 3456", "SSN\n[REDACTED]", 1),
    ("Badge 900123456", "Badge 900123456", 0),
    ("Direct Deposit Acct 000123456789", "Direct Deposit Acct [REDACTED]", 1),
    (
        "Routing 021000021 Account 4411-2233-9988",
        "Routing [REDACTED] Account [REDACTED]",
        2,
    ),
    ("Employer EIN 12-3456789", "Employer EIN [REDACTED]", 1),
    ("Account ****4821 Amount 1,996.04", "Account ****4821 Amount 1,996.04", 0),
    ("Social Security 167.92 1,343.36", "Social Security 167.92 1,343.36", 0),
    ("XXX-XX-6789", "XXX-XX-6789", 0),
    ("Pay date 2026-10-15 Check 12345678", "Pay date 2026-10-15 Check 12345678", 0),
    ("Acct 12345678901234567890", "Acct 12345678901234567890", 0),
]


@pytest.mark.parametrize(("text", "expected", "count"), TABLE, ids=[row[0] for row in TABLE])
def test_redaction_table(text: str, expected: str, count: int) -> None:
    assert redact_text(text) == (expected, count)


def test_spans_report_kinds_in_text_order() -> None:
    text = "EIN 12-3456789 SSN 123-45-6789 Routing 021000021"
    assert find_sensitive(text) == [
        Span(4, 14, "ein"),
        Span(19, 30, "ssn"),
        Span(39, 48, "account"),
    ]


def test_context_window_is_sixty_characters() -> None:
    near = "Social " + "x" * 52 + " 900123456"
    far = "Social " + "x" * 54 + " 900123456"
    assert redact_text(near)[1] == 1
    assert redact_text(far)[1] == 0


def test_context_words_match_whole_words_only() -> None:
    # "accounting" is not "account", "assn" is not "SSN".
    assert redact_text("Accounting dept 12345678")[1] == 0
    assert redact_text("ASSN 900123456")[1] == 0
    assert redact_text("acct# 12345678")[1] == 1


def test_redacted_text_keeps_its_lines() -> None:
    text = "\n".join(ACME_STUB_LINES)
    redacted, count = redact_text(text)
    assert count == 2
    assert redacted.count("\n") == text.count("\n")
    assert "900-12-3456" not in redacted
    assert ACME_ACCOUNT not in redacted
    assert REDACTED in redacted


def line(*words: tuple[str, float, float]) -> Line:
    return Line(tuple(Word(text, x0, 100, x1, 140) for text, x0, x1 in words))


def test_redact_image_blacks_out_matching_words_with_padding() -> None:
    image = Image.new("RGB", (600, 300), "white")
    lines = [line(("SSN", 10, 80), ("123-45-6789", 100, 300)), line(("Net", 320, 380))]
    redacted, count = redact_image(image, lines)
    assert count == 1
    assert redacted is not image
    assert image.getpixel((150, 120)) == (255, 255, 255)  # the input is untouched
    for x, y in [(96, 96), (150, 120), (303, 143)]:  # 4 px of padding on each side
        assert redacted.getpixel((x, y)) == (0, 0, 0)
    for x, y in [(95, 120), (305, 120), (50, 120), (350, 120)]:
        assert redacted.getpixel((x, y)) == (255, 255, 255)


def test_redact_image_spans_several_words() -> None:
    image = Image.new("RGB", (800, 300), "white")
    lines = [line(("SSN", 10, 80), ("900", 100, 160), ("12", 170, 200), ("3456", 210, 290))]
    redacted, count = redact_image(image, lines)
    assert count == 1
    for x in (120, 185, 250):
        assert redacted.getpixel((x, 120)) == (0, 0, 0)
    assert redacted.getpixel((40, 120)) == (255, 255, 255)


def test_redact_image_clips_padding_to_the_image() -> None:
    image = Image.new("RGB", (200, 50), "white")
    lines = [Line((Word("SSN", 0, 0, 30, 20), Word("123-45-6789", 32, 0, 200, 50)))]
    redacted, count = redact_image(image, lines)
    assert count == 1
    assert redacted.getpixel((199, 49)) == (0, 0, 0)


@pytest.mark.usefixtures("tesseract")
def test_redacted_image_reocrs_to_no_nine_digit_run() -> None:
    page = render_page(ACME_STUB_LINES)
    before = ocr_image(page)
    before_text = "\n".join(item.text for item in before.lines)
    assert "900-12-3456" in before_text  # the test means something only if OCR read it

    redacted, count = redact_image(page, before.lines)
    assert count == 2

    after = "\n".join(item.text for item in ocr_image(redacted).lines)
    digits_only = re.sub(r"[ -]", "", after)
    assert not re.search(r"\d{9}", digits_only), after
    assert "3456" not in after
    assert ACME_ACCOUNT[-6:] not in after
    assert "2,708.33" in after  # amounts survive


@pytest.mark.parametrize(
    ("confidence", "readable"),
    [(59.99, False), (60.0, True), (0.0, False), (95.0, True)],
)
def test_pages_below_sixty_mean_confidence_are_not_readable(
    confidence: float, readable: bool
) -> None:
    assert MIN_PAGE_CONFIDENCE == 60
    assert is_readable(confidence) is readable
