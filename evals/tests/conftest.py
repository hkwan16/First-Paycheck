"""Pin the environment before any eval test reads settings, as api/tests does.

Without this, ``pytest evals/tests`` on its own builds ``Settings()`` from the
developer's .env, including a live ANTHROPIC_API_KEY when one is linked for a
live eval run. ``make test`` only escaped that because api/tests/conftest.py is
collected first.

Also holds the ``tesseract`` fixture the tests that OCR share.
"""

from __future__ import annotations

import os

import pytest

from tests.support.documents import tesseract_available
from tests.support.env import pin_test_environment

pin_test_environment()


@pytest.fixture
def tesseract() -> None:
    """For tests that OCR (the extraction-smoke suite does): they skip on a
    laptop without the tesseract binary and fail in CI, which installs it."""
    if tesseract_available():
        return
    if os.environ.get("CI"):
        pytest.fail("tesseract must be installed in CI")
    pytest.skip("tesseract is not installed; the extraction-smoke suite needs it")
