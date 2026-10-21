# pypdfium2 ships no type information (no py.typed); the exemption is scoped to this file.
# mypy: disable-error-code="import-untyped"
"""Opening uploads: PDF text layers with word boxes, rasterized PDF pages, and
photos or scans (spec 004 rules 6-9). Worker only.
"""

from __future__ import annotations

import io
import logging
import warnings
from dataclasses import dataclass

import pdfplumber
import pypdfium2
from pdfminer.pdfparser import PDFSyntaxError
from pdfplumber.utils.exceptions import PdfminerException
from PIL import Image, ImageOps, UnidentifiedImageError

from ingest.layout import Line, Word, group_by_overlap

RASTER_DPI = 200
MAX_PAGES = 30
MIN_TEXT_CHARS = 20
MAX_IMAGE_EDGE = 3300
POINTS_PER_INCH = 72

__all__ = [
    "MAX_IMAGE_EDGE",
    "MAX_PAGES",
    "MIN_TEXT_CHARS",
    "RASTER_DPI",
    "PdfDocument",
    "PdfPage",
    "UnreadableDocument",
    "open_image",
    "rasterize",
    "read_pdf",
]

# pdfminer logs every malformed object it skips; a broken upload is reported
# once, as UnreadableDocument, instead.
logging.getLogger("pdfminer").setLevel(logging.ERROR)


class UnreadableDocument(Exception):
    """The bytes are not a PDF or image the readers can open."""


@dataclass(frozen=True)
class PdfPage:
    number: int  # 1-based
    lines: list[Line]
    has_text_layer: bool


@dataclass(frozen=True)
class PdfDocument:
    page_count: int
    # The first MAX_PAGES pages only.
    pages: list[PdfPage]


def read_pdf(data: bytes, *, max_pages: int = MAX_PAGES) -> PdfDocument:
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            page_count = len(pdf.pages)
            pages = [
                _read_page(page, number) for number, page in enumerate(pdf.pages[:max_pages], 1)
            ]
    except (PdfminerException, PDFSyntaxError, ValueError, TypeError, KeyError) as exc:
        raise UnreadableDocument(f"not a readable PDF ({type(exc).__name__})") from None
    if page_count == 0:
        raise UnreadableDocument("the PDF has no pages")
    return PdfDocument(page_count=page_count, pages=pages)


def _read_page(page: pdfplumber.page.Page, number: int) -> PdfPage:
    words = [
        Word(
            text=str(item["text"]),
            x0=float(item["x0"]),
            top=float(item["top"]),
            x1=float(item["x1"]),
            bottom=float(item["bottom"]),
        )
        for item in page.extract_words(keep_blank_chars=False, use_text_flow=False)
    ]
    characters = sum(len(word.text) for word in words)
    return PdfPage(
        number=number,
        lines=group_by_overlap(words),
        has_text_layer=characters >= MIN_TEXT_CHARS,
    )


def rasterize(data: bytes, page_index: int, *, dpi: int = RASTER_DPI) -> Image.Image:
    """One PDF page as an RGB image at ``dpi``."""
    try:
        pdf = pypdfium2.PdfDocument(data)
    except pypdfium2.PdfiumError as exc:
        raise UnreadableDocument(f"not a readable PDF ({exc})") from None
    try:
        page = pdf[page_index]
        try:
            bitmap = page.render(scale=dpi / POINTS_PER_INCH)
            image: Image.Image = bitmap.to_pil().convert("RGB")
        finally:
            page.close()
    finally:
        pdf.close()
    return image


def open_image(data: bytes) -> Image.Image:
    """A PNG or JPEG upload, upright, in RGB, at most MAX_IMAGE_EDGE pixels long."""
    try:
        with warnings.catch_warnings():
            # A decompression bomb is an unreadable upload, not a warning.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data))
            image.load()
    except (
        UnidentifiedImageError,
        OSError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        SyntaxError,
        ValueError,
    ) as exc:
        raise UnreadableDocument(f"not a readable image ({type(exc).__name__})") from None
    upright = ImageOps.exif_transpose(image).convert("RGB")
    longest = max(upright.size)
    if longest > MAX_IMAGE_EDGE:
        scale = MAX_IMAGE_EDGE / longest
        size = (round(upright.width * scale), round(upright.height * scale))
        upright = upright.resize(size, Image.Resampling.LANCZOS)
    return upright
