"""OCR with word boxes and confidence (spec 004 rules 10-11)."""

from __future__ import annotations

import pytest

from ingest.ocr import ocr_image
from tests.support.documents import noise_page, render_page

pytestmark = pytest.mark.usefixtures("tesseract")


def test_lines_words_boxes_and_confidence() -> None:
    page = ocr_image(render_page(["Gross Pay 2,708.33", "Net Pay 1,996.04"]))
    assert [line.text for line in page.lines] == ["Gross Pay 2,708.33", "Net Pay 1,996.04"]
    gross = page.lines[0].words[0]
    assert gross.text == "Gross"
    assert 100 <= gross.x0 < gross.x1
    assert 100 <= gross.top < gross.bottom
    assert all(
        word.conf is not None and 0 <= word.conf <= 100
        for line in page.lines
        for word in line.words
    )
    assert page.mean_confidence > 80


def test_a_page_with_no_words_has_zero_confidence() -> None:
    page = ocr_image(noise_page())
    assert page.mean_confidence < 60
    blank = ocr_image(render_page([]))
    assert blank.lines == []
    assert blank.mean_confidence == 0
