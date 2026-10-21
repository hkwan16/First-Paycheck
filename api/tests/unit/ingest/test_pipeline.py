"""prepare_document: from uploaded bytes to redacted model input (spec 004 rules 6-18)."""

from __future__ import annotations

import io
import re

import pytest
from PIL import Image

from ingest.ocr import ocr_image
from ingest.pipeline import MAX_MODEL_IMAGE_EDGE, prepare_document
from llm.gateway import ImagePage, TextPage
from tests.support.documents import (
    ACME_ACCOUNT,
    ACME_SSN,
    ACME_STUB_LINES,
    encode,
    image_pdf,
    noise_page,
    render_page,
    text_pdf,
)

SSN_DIGITS = re.compile(r"\d{3}[ -]?\d{2}[ -]?\d{4}")


def test_text_layer_pdf_is_redacted_as_text() -> None:
    prepared = prepare_document(text_pdf([ACME_STUB_LINES]), "application/pdf")
    assert prepared.page_count == 1
    assert prepared.redaction_count == 2
    assert prepared.withheld_pages == []
    [page] = prepared.pages
    assert (page.number, page.source, page.redactions) == (1, "text", 2)
    assert page.lines[2] == "SSN [REDACTED]"
    assert page.lines[3] == "Direct Deposit Acct [REDACTED]"
    [model_page] = prepared.model_pages
    assert isinstance(model_page, TextPage)
    assert model_page.number == 1
    assert ACME_SSN not in model_page.text
    assert ACME_ACCOUNT not in model_page.text
    assert "Gross Pay 2,708.33" in model_page.text


def reocr(page: ImagePage) -> str:
    image = Image.open(io.BytesIO(page.png))
    assert image.format == "PNG"
    return "\n".join(line.text for line in ocr_image(image).lines)


@pytest.mark.usefixtures("tesseract")
@pytest.mark.parametrize(
    ("data", "content_type"),
    [
        (encode(render_page(ACME_STUB_LINES)), "image/png"),
        (encode(render_page(ACME_STUB_LINES), "JPEG"), "image/jpeg"),
        (image_pdf([render_page(ACME_STUB_LINES)]), "application/pdf"),
    ],
    ids=["png", "jpeg", "scanned-pdf"],
)
def test_images_and_scans_are_redacted_in_the_image(data: bytes, content_type: str) -> None:
    prepared = prepare_document(data, content_type)
    assert prepared.page_count == 1
    assert prepared.redaction_count == 2
    [page] = prepared.pages
    assert page.source == "ocr"
    assert page.mean_confidence is not None
    assert page.mean_confidence >= 60
    assert any("[REDACTED]" in line for line in page.lines)
    [model_page] = prepared.model_pages
    assert isinstance(model_page, ImagePage)
    seen = reocr(model_page)
    assert not SSN_DIGITS.search(seen), seen
    assert ACME_ACCOUNT not in seen
    assert "1,996.04" in seen


@pytest.mark.usefixtures("tesseract")
def test_low_confidence_page_is_withheld() -> None:
    readable = render_page(ACME_STUB_LINES)
    prepared = prepare_document(image_pdf([readable, noise_page()]), "application/pdf")
    assert prepared.page_count == 2
    assert prepared.withheld_pages == [2]
    withheld = prepared.pages[1]
    assert (withheld.withheld, withheld.lines, withheld.model_page) == ("low_confidence", [], None)
    assert [page.number for page in prepared.model_pages] == [1]


@pytest.mark.usefixtures("tesseract")
def test_a_document_with_no_readable_page_has_no_model_input() -> None:
    prepared = prepare_document(encode(noise_page()), "image/png")
    assert prepared.model_pages == []
    assert prepared.withheld_pages == [1]
    assert prepared.redaction_count == 0


def test_pages_past_the_limit_are_withheld() -> None:
    pages = [[f"Benefits summary page {n} of 32"] for n in range(1, 33)]
    prepared = prepare_document(text_pdf(pages), "application/pdf")
    assert prepared.page_count == 32
    assert len(prepared.model_pages) == 30
    assert prepared.withheld_pages == [31, 32]
    assert prepared.pages[-1].withheld == "page_limit"


@pytest.mark.usefixtures("tesseract")
def test_model_images_are_at_most_2576_pixels() -> None:
    big = render_page(ACME_STUB_LINES, size=(2550, 3300), font_size=60)
    prepared = prepare_document(encode(big), "image/png")
    [model_page] = prepared.model_pages
    assert isinstance(model_page, ImagePage)
    image = Image.open(io.BytesIO(model_page.png))
    assert max(image.size) == MAX_MODEL_IMAGE_EDGE == 2576


def test_unknown_content_types_are_refused() -> None:
    with pytest.raises(ValueError, match="text/plain"):
        prepare_document(b"hello", "text/plain")
