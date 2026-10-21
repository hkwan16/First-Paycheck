# pytesseract ships no type information (no py.typed); the exemption is scoped to this file.
# mypy: disable-error-code="import-untyped"
"""Tesseract OCR with word boxes and confidence (spec 004 rules 10-11). Worker only.

The Debian tesseract build is pinned in ``api/Dockerfile`` because OCR output
differs between versions; CI runs these paths inside that image.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

import pytesseract
from PIL import Image

from ingest.layout import Line, Word

TESSERACT_CONFIG = "--psm 6"
LANGUAGE = "eng"

__all__ = ["LANGUAGE", "TESSERACT_CONFIG", "OcrPage", "ocr_image"]


@dataclass(frozen=True)
class OcrPage:
    lines: list[Line]
    # Mean word confidence, 0-100; 0 when no word was found.
    mean_confidence: float


def ocr_image(image: Image.Image) -> OcrPage:
    data = pytesseract.image_to_data(
        image, lang=LANGUAGE, config=TESSERACT_CONFIG, output_type=pytesseract.Output.DICT
    )
    grouped: dict[tuple[int, int, int], list[Word]] = defaultdict(list)
    confidences: list[float] = []
    for index, raw_text in enumerate(data["text"]):
        text = str(raw_text).strip()
        conf = float(data["conf"][index])
        if not text or conf < 0:
            continue
        left, top = int(data["left"][index]), int(data["top"][index])
        word = Word(
            text=text,
            x0=left,
            top=top,
            x1=left + int(data["width"][index]),
            bottom=top + int(data["height"][index]),
            conf=conf,
        )
        key = (
            int(data["block_num"][index]),
            int(data["par_num"][index]),
            int(data["line_num"][index]),
        )
        grouped[key].append(word)
        confidences.append(conf)
    lines = [
        Line(tuple(sorted(words, key=lambda item: item.x0))) for _, words in sorted(grouped.items())
    ]
    mean = sum(confidences) / len(confidences) if confidences else 0.0
    return OcrPage(lines=lines, mean_confidence=mean)
