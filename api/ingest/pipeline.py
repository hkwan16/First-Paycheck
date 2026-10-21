"""From uploaded bytes to redacted model input (spec 004 rules 6-18). Worker only.

Each page is either read from its PDF text layer and redacted as text, or
rasterized (PDF) or opened (PNG, JPEG), OCR'd and redacted in the image. A
page whose OCR mean confidence is below 60 is withheld: nothing from it is
shown or sent. Pages past ``MAX_PAGES`` are withheld too.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Literal

from PIL import Image

from ingest.ocr import ocr_image
from ingest.reader import MAX_PAGES, open_image, rasterize, read_pdf
from ingest.redact import is_readable, redact_image, redact_text
from llm.gateway import ImagePage, ModelPage, TextPage

MAX_MODEL_IMAGE_EDGE = 2576
PDF = "application/pdf"
IMAGE_TYPES = frozenset({"image/png", "image/jpeg"})

PageSource = Literal["text", "ocr"]
WithheldReason = Literal["low_confidence", "page_limit"]

__all__ = [
    "MAX_MODEL_IMAGE_EDGE",
    "PreparedDocument",
    "PreparedPage",
    "prepare_document",
]


@dataclass(frozen=True)
class PreparedPage:
    number: int
    source: PageSource | None
    # Redacted lines; empty for a withheld page.
    lines: list[str]
    redactions: int = 0
    mean_confidence: float | None = None
    model_page: ModelPage | None = None
    withheld: WithheldReason | None = None


@dataclass(frozen=True)
class PreparedDocument:
    page_count: int
    pages: list[PreparedPage] = field(default_factory=list)

    @property
    def redaction_count(self) -> int:
        return sum(page.redactions for page in self.pages)

    @property
    def model_pages(self) -> list[ModelPage]:
        return [page.model_page for page in self.pages if page.model_page is not None]

    @property
    def withheld_pages(self) -> list[int]:
        return [page.number for page in self.pages if page.withheld is not None]


def prepare_document(data: bytes, content_type: str) -> PreparedDocument:
    """Read, OCR and redact ``data``. Raises ``UnreadableDocument`` for a file
    that cannot be opened."""
    if content_type == PDF:
        return _prepare_pdf(data)
    if content_type in IMAGE_TYPES:
        return PreparedDocument(page_count=1, pages=[_prepare_image(open_image(data), 1)])
    raise ValueError(f"cannot read content type {content_type!r}")


def _prepare_pdf(data: bytes) -> PreparedDocument:
    document = read_pdf(data)
    pages: list[PreparedPage] = []
    for page in document.pages:
        if page.has_text_layer:
            text = "\n".join(line.text for line in page.lines)
            redacted, count = redact_text(text)
            pages.append(
                PreparedPage(
                    number=page.number,
                    source="text",
                    lines=redacted.split("\n"),
                    redactions=count,
                    model_page=TextPage(number=page.number, text=redacted),
                )
            )
        else:
            pages.append(_prepare_image(rasterize(data, page.number - 1), page.number))
    pages.extend(
        PreparedPage(number=number, source=None, lines=[], withheld="page_limit")
        for number in range(MAX_PAGES + 1, document.page_count + 1)
    )
    return PreparedDocument(page_count=document.page_count, pages=pages)


def _prepare_image(image: Image.Image, number: int) -> PreparedPage:
    ocr = ocr_image(image)
    if not is_readable(ocr.mean_confidence):
        return PreparedPage(
            number=number,
            source="ocr",
            lines=[],
            mean_confidence=ocr.mean_confidence,
            withheld="low_confidence",
        )
    redacted_image, count = redact_image(image, ocr.lines)
    redacted_text, _ = redact_text("\n".join(line.text for line in ocr.lines))
    return PreparedPage(
        number=number,
        source="ocr",
        lines=redacted_text.split("\n") if ocr.lines else [],
        redactions=count,
        mean_confidence=ocr.mean_confidence,
        model_page=ImagePage(number=number, png=_png(redacted_image)),
    )


def _png(image: Image.Image) -> bytes:
    longest = max(image.size)
    if longest > MAX_MODEL_IMAGE_EDGE:
        scale = MAX_MODEL_IMAGE_EDGE / longest
        size = (round(image.width * scale), round(image.height * scale))
        image = image.resize(size, Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()
