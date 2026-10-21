"""The checkin suite: spec 015's finder scenarios as fixtures, and its scoring."""

from __future__ import annotations

import re
from pathlib import Path

from evals.suites import SUITES, checkin
from evals.suites.base import Budget

SPEC = Path(__file__).resolve().parents[2] / "docs" / "specs" / "015-check-ins.md"


def spec_finder_tests() -> list[str]:
    """The test names of the spec's finder table, in order."""
    examples = SPEC.read_text().split("## Hand-worked examples", 1)[1]
    section = examples.split("### Finders", 1)[1].split("###", 1)[0]
    return re.findall(r"^\| \d+ \| `(test_[a-z0-9_]+)` \|", section, flags=re.MULTILINE)


def test_every_finder_example_has_a_case() -> None:
    names = spec_finder_tests()
    assert len(names) == 18
    assert [case.id for case in checkin.load_cases()] == [f"spec-015-{name}" for name in names]


def test_the_suite_passes_on_the_committed_fixtures() -> None:
    result = SUITES["checkin"].run(Budget(0))
    assert result.failures == []
    assert result.metrics == {"precision": 1.0, "recall": 1.0, "fields_exact": 1.0}
    assert result.cases == 18


def test_a_missed_finding_lowers_recall() -> None:
    case = next(c for c in checkin.load_cases() if c.id.endswith("test_election_not_applied"))
    missed = case.model_copy(update={"facts": case.facts.model_copy(update={"k401": None})})
    result = checkin.score([missed])
    assert result.metrics["recall"] == 0.0
    assert result.metrics["precision"] == 1.0
    assert "not found" in result.failures[0]


def test_an_extra_finding_lowers_precision() -> None:
    case = next(c for c in checkin.load_cases() if c.id.endswith("test_election_not_applied"))
    extra = case.model_copy(update={"expected": []})
    result = checkin.score([extra])
    assert result.metrics["precision"] == 0.0
    assert "not expected" in result.failures[0]


def test_a_wrong_field_lowers_fields_exact() -> None:
    case = next(c for c in checkin.load_cases() if c.id.endswith("test_raise"))
    label = case.expected[0].model_copy(update={"severity": "warning"})
    result = checkin.score([case.model_copy(update={"expected": [label]})])
    assert result.metrics == {"precision": 1.0, "recall": 1.0, "fields_exact": 0.0}
    assert "severity" in result.failures[0]
