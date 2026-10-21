"""``recurring.detect``: a recorded no-op until recurring detection lands in M5."""

from __future__ import annotations

from typing import Any

from jobs.context import JobContext


def detect(ctx: JobContext) -> dict[str, Any]:
    return {"status": "not_implemented", "detected": 0}
