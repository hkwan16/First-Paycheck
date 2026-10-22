"""Registered eval suites, by name. Add each new suite here and to evals/baseline.json."""

from __future__ import annotations

from evals.suites import (
    benefits_extraction,
    calc,
    categorization,
    categorization_rules,
    checkin,
    explain,
    explain_smoke,
    extraction,
    extraction_smoke,
    recurring,
)
from evals.suites.base import Suite

SUITES: dict[str, Suite] = {
    suite.name: suite
    for suite in (
        benefits_extraction.SUITE,
        calc.SUITE,
        categorization.SUITE,
        categorization_rules.SUITE,
        checkin.SUITE,
        explain.SUITE,
        explain_smoke.SUITE,
        extraction.SUITE,
        extraction_smoke.SUITE,
        recurring.SUITE,
    )
}
