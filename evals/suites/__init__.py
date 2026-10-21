"""Registered eval suites, by name. Add each new suite here and to evals/baseline.json."""

from __future__ import annotations

from evals.suites import (
    calc,
    categorization_rules,
    explain,
    explain_smoke,
    extraction,
    extraction_smoke,
)
from evals.suites.base import Suite

SUITES: dict[str, Suite] = {
    suite.name: suite
    for suite in (
        calc.SUITE,
        categorization_rules.SUITE,
        explain.SUITE,
        explain_smoke.SUITE,
        extraction.SUITE,
        extraction_smoke.SUITE,
    )
}
