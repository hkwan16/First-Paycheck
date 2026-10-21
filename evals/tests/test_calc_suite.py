"""The calc suite posts hand-worked spec examples to the calculator routes."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import CurrentUser
from app.main import create_app
from evals.suites import calc
from evals.suites.base import Budget


def echo_client() -> TestClient:
    """A stand-in API: /calc/double returns twice the input."""
    app = FastAPI()

    @app.post("/calc/double")
    def double(body: dict[str, int]) -> dict[str, Any]:
        return {"result_cents": body["amount_cents"] * 2, "capped": False}

    return TestClient(app)


def case(case_id: str, amount: int, expected: dict[str, Any]) -> calc.CalcCase:
    return calc.CalcCase(
        id=case_id, route="/calc/double", request={"amount_cents": amount}, expected=expected
    )


def test_matching_cases_pass() -> None:
    result = calc.run(
        Budget(0), cases=[case("ok", 150, {"result_cents": 300})], client=echo_client()
    )
    assert result.metrics == {"pass_rate": 1.0}
    assert result.cases == 1
    assert result.failures == []
    assert result.cost_cents == 0


def test_mismatches_are_reported_per_field() -> None:
    cases = [
        case("ok", 1, {"result_cents": 2}),
        case("off", 1, {"result_cents": 3, "capped": False}),
        case("missing", 1, {"months": 4}),
    ]
    result = calc.run(Budget(0), cases=cases, client=echo_client())
    assert result.metrics == {"pass_rate": pytest.approx(1 / 3)}
    assert result.failures == [
        "off: result_cents expected 3, got 2",
        "missing: months missing from the response",
    ]


def test_http_errors_fail_the_case() -> None:
    bad = calc.CalcCase(id="404", route="/calc/nope", request={}, expected={})
    result = calc.run(Budget(0), cases=[bad], client=echo_client())
    assert result.metrics == {"pass_rate": 0.0}
    assert result.failures[0].startswith("404: HTTP 404")


def test_nested_expectations_compare_as_subsets() -> None:
    assert calc.mismatches({"a": {"b": 1}}, {"a": {"b": 1, "c": 2}}) == []
    assert calc.mismatches({"a": {"b": 1}}, {"a": {"b": 2}}) == ["a.b expected 1, got 2"]
    assert calc.mismatches({"a": [1, 2]}, {"a": [1, 2]}) == []


def test_no_cases_is_a_vacuous_pass() -> None:
    result = calc.run(Budget(0), cases=[])
    assert result.metrics == {"pass_rate": 1.0}
    assert result.cases == 0


def test_cases_load_from_json_files(tmp_path: Path) -> None:
    (tmp_path / "k401.json").write_text(
        json.dumps(
            [
                {
                    "id": "spec-006-ex1",
                    "route": "/calc/401k-match",
                    "request": {"salary_cents": 6000000},
                    "expected": {"missed_cents": 60000},
                }
            ]
        )
    )
    (cases,) = calc.load_cases(tmp_path)
    assert cases.id == "spec-006-ex1"
    assert cases.route == "/calc/401k-match"


def test_malformed_case_files_are_rejected(tmp_path: Path) -> None:
    (tmp_path / "bad.json").write_text(json.dumps([{"id": "x", "route": "/calc/a"}]))
    with pytest.raises(ValueError, match=r"bad\.json"):
        calc.load_cases(tmp_path)


def test_duplicate_case_ids_are_rejected(tmp_path: Path) -> None:
    entry = {"id": "dup", "route": "/calc/a", "request": {}, "expected": {}}
    (tmp_path / "a.json").write_text(json.dumps([entry]))
    (tmp_path / "b.json").write_text(json.dumps([entry]))
    with pytest.raises(ValueError, match="dup"):
        calc.load_cases(tmp_path)


def test_the_eval_client_authenticates_as_the_eval_user() -> None:
    app = create_app()

    @app.get("/whoami")
    def whoami(user: CurrentUser) -> dict[str, str]:
        return {"id": str(user.id)}

    response = calc.eval_client(app).get("/whoami")
    assert response.json() == {"id": str(calc.EVAL_USER_ID)}


SPEC_006 = Path(__file__).resolve().parents[2] / "docs" / "specs" / "006-401k-match.md"


def test_every_spec_006_example_is_a_case() -> None:
    """The example table's test names (`test_x_y`) are the case ids (`spec-006-x-y`)."""
    names = re.findall(r"^\| \w+ \| `test_(\w+)`", SPEC_006.read_text(), flags=re.MULTILINE)
    assert len(names) == 12
    ids = {case.id for case in calc.load_cases()}
    for name in names:
        assert f"spec-006-{name.replace('_', '-')}" in ids, name


def test_the_committed_cases_pass_through_the_route() -> None:
    result = calc.run(Budget(0))
    assert result.failures == []
    assert result.metrics == {"pass_rate": 1.0}
    assert result.cases >= 12
