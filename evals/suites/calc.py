"""The calc suite: hand-worked spec examples, run through the HTTP routes.

Each ``evals/fixtures/calc/*.json`` file holds a list of cases transcribed from
the "Hand-worked examples" section of a ``docs/specs/`` file::

    [{"id": "spec-006-ex1", "route": "/calc/401k-match",
      "request": {...}, "expected": {...}}]

A case passes when the route returns 200 and every key in ``expected``
matches the response (nested objects compare as subsets). Deterministic: the
baseline is 100% and no drop is tolerated.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import AuthUser, get_current_user
from app.main import create_app
from evals.suites.base import Budget, Suite, SuiteResult

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "calc"
EVAL_USER_ID = uuid.UUID("00000000-0000-4000-8000-0000000e7a15")
_CASE_KEYS = {"id", "route", "request", "expected"}


@dataclass(frozen=True)
class CalcCase:
    id: str
    route: str
    request: dict[str, Any]
    expected: dict[str, Any]


def load_cases(directory: Path = FIXTURES) -> list[CalcCase]:
    cases: list[CalcCase] = []
    seen: set[str] = set()
    for path in sorted(directory.glob("*.json")):
        entries = json.loads(path.read_text())
        if not isinstance(entries, list):
            raise ValueError(f"{path.name}: expected a list of cases")
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != _CASE_KEYS:
                raise ValueError(f"{path.name}: each case needs exactly {sorted(_CASE_KEYS)}")
            if entry["id"] in seen:
                raise ValueError(f"{path.name}: duplicate case id {entry['id']!r}")
            seen.add(entry["id"])
            cases.append(CalcCase(**entry))
    return cases


def mismatches(expected: Any, actual: Any, path: str = "") -> list[str]:
    """Differences between ``expected`` and ``actual``; dicts compare as subsets."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{path or 'response'} expected an object, got {actual!r}"]
        found: list[str] = []
        for key, value in expected.items():
            where = f"{path}.{key}" if path else key
            if key not in actual:
                found.append(f"{where} missing from the response")
            else:
                found.extend(mismatches(value, actual[key], where))
        return found
    if expected != actual:
        return [f"{path} expected {expected!r}, got {actual!r}"]
    return []


def eval_client(app: FastAPI | None = None) -> TestClient:
    """A client for the real app, signed in as a fixed eval user.

    Calculator routes are stateless, so no database is needed.
    """
    if app is None:
        app = create_app()
    eval_user = AuthUser(id=EVAL_USER_ID, claims={"sub": str(EVAL_USER_ID), "aud": "authenticated"})
    app.dependency_overrides[get_current_user] = lambda: eval_user
    return TestClient(app)


def run(
    budget: Budget, *, cases: list[CalcCase] | None = None, client: TestClient | None = None
) -> SuiteResult:
    cases = load_cases() if cases is None else cases
    if not cases:
        return SuiteResult(metrics={"pass_rate": 1.0}, cases=0)
    client = client or eval_client()
    failures: list[str] = []
    passed = 0
    for case in cases:
        response = client.post(case.route, json=case.request)
        if response.status_code != 200:
            problems = [f"HTTP {response.status_code} {response.text[:200]}"]
        else:
            problems = mismatches(case.expected, response.json())
        failures.extend(f"{case.id}: {problem}" for problem in problems)
        passed += not problems
    return SuiteResult(
        metrics={"pass_rate": passed / len(cases)}, cases=len(cases), failures=failures
    )


SUITE = Suite(name="calc", llm=False, run=run)
