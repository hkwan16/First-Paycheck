"""Reading uploads (spec 004 rules 6-9 and 13): text layers, rasterizing, images."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from ingest.layout import Line, Word, group_by_overlap, page_text
from ingest.reader import (
    MAX_IMAGE_EDGE,
    UnreadableDocument,
    open_image,
    rasterize,
    read_pdf,
)
from tests.support.documents import (
    ACME_STUB_LINES,
    PAGE_PIXELS,
    encode,
    image_pdf,
    render_page,
    text_pdf,
)


def test_text_layer_pages_keep_their_lines_and_word_boxes() -> None:
    document = read_pdf(text_pdf([ACME_STUB_LINES]))
    assert document.page_count == 1
    [page] = document.pages
    assert page.number == 1
    assert page.has_text_layer
    assert [line.text for line in page.lines] == ACME_STUB_LINES
    first = page.lines[0].words[0]
    assert first.text == "ACME"
    assert 70 <= first.x0 < first.x1 < 612
    assert 0 < first.top < first.bottom < 792


def test_scanned_pages_have_no_text_layer() -> None:
    document = read_pdf(image_pdf([render_page(["Gross Pay 2,708.33"])]))
    assert [page.has_text_layer for page in document.pages] == [False]


def test_a_page_needs_twenty_characters_to_count_as_text() -> None:
    document = read_pdf(text_pdf([["Page 1 of 2"], ["Gross Pay 2,708.33 Net Pay 1,996.04"]]))
    assert [page.has_text_layer for page in document.pages] == [False, True]


def test_only_the_first_pages_are_read() -> None:
    document = read_pdf(text_pdf([[f"Benefits summary page {n} of 32"] for n in range(32)]))
    assert document.page_count == 32
    assert [page.number for page in document.pages] == list(range(1, 31))


def test_rasterize_at_200_dpi() -> None:
    image = rasterize(text_pdf([ACME_STUB_LINES]), 0)
    assert image.size == PAGE_PIXELS
    assert image.mode == "RGB"


@pytest.mark.parametrize("data", [b"%PDF-1.4 not really", b"", b"\x89PNG\r\n\x1a\n broken"])
def test_unreadable_files_raise(data: bytes) -> None:
    with pytest.raises(UnreadableDocument):
        read_pdf(data)
    with pytest.raises(UnreadableDocument):
        open_image(data)


def test_open_image_applies_exif_orientation() -> None:
    upright = Image.new("RGB", (40, 20), "white")
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise to display
    out = io.BytesIO()
    upright.save(out, format="JPEG", exif=exif)
    opened = open_image(out.getvalue())
    assert opened.size == (20, 40)
    assert opened.mode == "RGB"


def test_open_image_scales_huge_photos_down() -> None:
    photo = Image.new("L", (4000, 2000), 255)
    opened = open_image(encode(photo))
    assert opened.size == (MAX_IMAGE_EDGE, 1650)
    assert opened.mode == "RGB"


def test_group_by_overlap_orders_lines_and_words() -> None:
    words = [
        Word("Pay", 300, 101, 340, 119),
        Word("Net", 260, 99, 295, 121),
        Word("Gross", 10, 49, 60, 71),
        Word("1,996.04", 360, 100, 440, 120),
    ]
    lines = group_by_overlap(words)
    assert [line.text for line in lines] == ["Gross", "Net Pay 1,996.04"]


def test_page_text_maps_characters_back_to_words() -> None:
    lines = [
        Line((Word("SSN", 0, 0, 1, 1), Word("123-45-6789", 2, 0, 3, 1))),
        Line((Word("Net", 0, 2, 1, 3),)),
    ]
    text, spans = page_text(lines)
    assert text == "SSN 123-45-6789\nNet"
    assert [(start, end) for start, end, _ in spans] == [(0, 3), (4, 15), (16, 19)]
    assert spans[1][2].text == "123-45-6789"
