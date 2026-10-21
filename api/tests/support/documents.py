"""Synthetic documents for ingest tests, built in memory with no fixtures on disk.

* ``text_pdf`` writes a real text-layer PDF by hand (Helvetica, one line per
  row), small enough to read in full: pdfplumber extracts its words exactly.
* ``render_page`` draws lines of text onto a white page with Pillow's bundled
  scalable font, the way a scan or a phone photo of a stub looks to OCR.
* ``image_pdf`` wraps page images in a PDF with no text layer (a scanned PDF).
"""

from __future__ import annotations

import io
import shutil
from collections.abc import Sequence

from PIL import Image, ImageDraw, ImageFont

LETTER_POINTS = (612, 792)
PAGE_PIXELS = (1700, 2200)  # letter at 200 dpi

# A stub whose text matches tests/fixtures/llm/extract_pay_stub.json.
ACME_STUB_LINES = [
    "ACME CORP EARNINGS STATEMENT",
    "Employee RIVERA, J",
    "SSN 900-12-3456",
    "Direct Deposit Acct 000123456789",
    "Pay Date 10/15/2026",
    "Period 10/01/2026 - 10/15/2026",
    "Pay Frequency Semi-monthly",
    "Gross Pay 2,708.33",
    "Federal Income Tax 297.76",
    "Social Security 167.92",
    "Medicare 39.27",
    "CA State Tax 98.14",
    "CA SDI 32.50",
    "Medical Pretax 62.50",
    "Dental/Vision 14.20",
    "Net Pay 1,996.04",
]
ACME_SSN = "900-12-3456"
ACME_ACCOUNT = "000123456789"


def tesseract_available() -> bool:
    return shutil.which("tesseract") is not None


def _pdf_string(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"({escaped})"


def text_pdf(pages: Sequence[Sequence[str]], *, font_size: int = 11) -> bytes:
    """A PDF with one text-layer page per entry, each line on its own row."""
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog = add(b"")  # filled in once the pages object exists
    pages_obj = add(b"")
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    kids: list[int] = []
    for lines in pages:
        ops = [f"BT /F1 {font_size} Tf {font_size + 4} TL 72 720 Td"]
        for line in lines:
            ops.append(f"{_pdf_string(line)} Tj T*")
        ops.append("ET")
        stream = "\n".join(ops).encode("latin-1")
        content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        kids.append(
            add(
                (
                    f"<< /Type /Page /Parent {pages_obj} 0 R"
                    f" /MediaBox [0 0 {LETTER_POINTS[0]} {LETTER_POINTS[1]}]"
                    f" /Resources << /Font << /F1 {font} 0 R >> >> /Contents {content} 0 R >>"
                ).encode()
            )
        )
    objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_obj} 0 R >>".encode()
    kid_refs = " ".join(f"{kid} 0 R" for kid in kids)
    objects[pages_obj - 1] = f"<< /Type /Pages /Kids [{kid_refs}] /Count {len(kids)} >>".encode()

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % number + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(
        b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objects) + 1, catalog, xref)
    )
    return out.getvalue()


def render_page(
    lines: Sequence[str],
    *,
    size: tuple[int, int] = PAGE_PIXELS,
    font_size: int = 40,
    margin: int = 120,
) -> Image.Image:
    """Black text on a white page, one line per row."""
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=font_size)
    y = margin
    for line in lines:
        draw.text((margin, y), line, fill="black", font=font)
        y += int(font_size * 1.8)
    return image


def noise_page(size: tuple[int, int] = (800, 1000)) -> Image.Image:
    """Speckle with no words in it: OCR finds nothing it is confident about.

    The speckle positions come from Knuth's multiplicative hash, so the page is
    the same on every run without a random number generator.
    """
    width, height = size
    image = Image.new("L", size, 255)
    pixels = image.load()
    assert pixels is not None
    for index in range(width * height // 6):
        scattered = (index * 2_654_435_761) % (width * height)
        pixels[scattered % width, scattered // width] = (index * 40_503) % 160
    return image.convert("RGB")


def encode(image: Image.Image, format: str = "PNG") -> bytes:
    out = io.BytesIO()
    image.save(out, format=format)
    return out.getvalue()


def image_pdf(images: Sequence[Image.Image]) -> bytes:
    """A PDF of page images with no text layer, like a scanner's output."""
    out = io.BytesIO()
    first, *rest = [image.convert("RGB") for image in images]
    first.save(out, format="PDF", save_all=True, append_images=rest, resolution=200.0)
    return out.getvalue()
