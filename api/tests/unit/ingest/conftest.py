"""Ingest unit tests: no database, no network. Tests that OCR need the
tesseract binary; they skip on a laptop without it and fail in CI, where the
``ingest-in-docker`` job runs them against the pinned Debian build."""

from __future__ import annotations

import os

import pytest

from tests.support.documents import tesseract_available


@pytest.fixture
def tesseract() -> None:
    if tesseract_available():
        return
    if os.environ.get("CI"):
        pytest.fail("tesseract must be installed in CI")
    pytest.skip("tesseract is not installed; OCR tests run in the ingest-in-docker job")
