"""The checkin suite: spec 015's finders over seeded scenarios.

No LLM, no database, no network. ``evals/fixtures/checkin/scenarios.json``
holds one case per row of the spec's finder table: the facts (the November
user's stubs, decisions, goal, charges and events, with fixed ids) and the
findings the spec expects, written by hand from the spec's arithmetic, never
from the finders. Each case runs ``checkin.findings.all_findings``.

Metrics (deterministic, no drop tolerated), over every case, with a finding
matched to a label by ``(kind, key)``:

- ``precision``: matched findings / findings produced.
- ``recall``: matched labels / labels.
- ``fields_exact``: of the matches, the share whose severity and every
  labeled payload field equal the label's (payload compared as JSON).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict

from checkin.findings import Facts, all_findings
from evals.suites.base import Budget, Suite, SuiteResult

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "checkin" / "scenarios.json"


class Label(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: str
    severity: str
    key: str
    # Only the payload fields the spec states; compared as JSON values.
    payload: dict[str, Any]


class Case(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    facts: Facts
    expected: list[Label]


def load_cases(path: Path = FIXTURE) -> list[Case]:
    cases = [Case.model_validate(entry) for entry in json.loads(path.read_text())]
    ids = [case.id for case in cases]
    if len(set(ids)) != len(ids):
        raise ValueError(f"{path.name}: duplicate case ids")
    return cases


def _differences(label: Label, severity: str, payload: dict[str, Any]) -> list[str]:
    problems = [] if severity == label.severity else [f"severity {severity} != {label.severity}"]
    for name, expected in label.payload.items():
        if payload.get(name, "<missing>") != expected:
            problems.append(f"{name} {payload.get(name, '<missing>')!r} != {expected!r}")
    return problems


def score(cases: Sequence[Case]) -> SuiteResult:
    produced_total = labeled_total = matched = exact = 0
    failures: list[str] = []
    for case in cases:
        found = {(finding.kind.value, finding.key): finding for finding in all_findings(case.facts)}
        labels = {(label.kind, label.key): label for label in case.expected}
        produced_total += len(found)
        labeled_total += len(labels)
        for kind, key in sorted(found.keys() | labels.keys()):
            finding, label = found.get((kind, key)), labels.get((kind, key))
            if label is None:
                failures.append(f"{case.id}: {kind} {key} found, not expected")
            elif finding is None:
                failures.append(f"{case.id}: {kind} {key} expected, not found")
            else:
                matched += 1
                problems = _differences(
                    label, finding.severity.value, finding.payload.model_dump(mode="json")
                )
                if problems:
                    failures.append(f"{case.id}: {kind} {key}: {'; '.join(problems)}")
                else:
                    exact += 1
    return SuiteResult(
        metrics={
            "precision": matched / produced_total if produced_total else 1.0,
            "recall": matched / labeled_total if labeled_total else 1.0,
            "fields_exact": exact / matched if matched else 1.0,
        },
        cases=len(cases),
        failures=failures,
    )


def run(budget: Budget) -> SuiteResult:
    return score(load_cases())


SUITE = Suite(name="checkin", llm=False, run=run)
