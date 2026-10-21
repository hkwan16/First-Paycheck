"""The eval runner: suite selection, cost cap, baseline comparison and the CLI."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evals import run
from evals.suites.base import Budget, CostCapExceeded, Suite, SuiteResult


def fixed(name: str, *, llm: bool = False, **metrics: float) -> Suite:
    def execute(budget: Budget) -> SuiteResult:
        return SuiteResult(metrics=dict(metrics), cases=1, failures=[], cost_cents=0)

    return Suite(name=name, llm=llm, run=execute)


def spending(name: str, cents: float) -> Suite:
    def execute(budget: Budget) -> SuiteResult:
        budget.charge(cents)
        return SuiteResult(metrics={"accuracy": 1.0}, cases=1, failures=[], cost_cents=cents)

    return Suite(name=name, llm=True, run=execute)


REGISTRY = {
    "calc": fixed("calc", pass_rate=1.0),
    "rules": fixed("rules", accuracy=0.9),
    "extraction": fixed("extraction", llm=True, field_accuracy=0.95),
}


def test_select_by_name_and_alias() -> None:
    assert [s.name for s in run.select_suites(["calc"], REGISTRY)] == ["calc"]
    assert [s.name for s in run.select_suites(["free"], REGISTRY)] == ["calc", "rules"]
    assert [s.name for s in run.select_suites(["llm"], REGISTRY)] == ["extraction"]
    assert len(run.select_suites(["all"], REGISTRY)) == 3


def test_select_deduplicates_and_keeps_order() -> None:
    names = [s.name for s in run.select_suites(["rules", "free"], REGISTRY)]
    assert names == ["rules", "calc"]


def test_unknown_suite_is_an_error() -> None:
    with pytest.raises(ValueError, match="nope"):
        run.select_suites(["nope"], REGISTRY)


def test_budget_refuses_spend_past_the_cap() -> None:
    budget = Budget(max_cents=5)
    budget.charge(3)
    with pytest.raises(CostCapExceeded):
        budget.charge(3)
    assert budget.spent_cents == 6


def test_deterministic_suites_allow_no_drop() -> None:
    result = SuiteResult(metrics={"pass_rate": 0.99}, cases=100, failures=[], cost_cents=0)
    assert run.regressions(result, {"pass_rate": 1.0}, tolerance=0.0) == [
        "pass_rate 0.9900 < baseline 1.0000"
    ]


def test_llm_suites_allow_two_points() -> None:
    result = SuiteResult(metrics={"field_accuracy": 0.935}, cases=10, failures=[], cost_cents=1)
    assert run.regressions(result, {"field_accuracy": 0.95}, tolerance=0.02) == []
    worse = SuiteResult(metrics={"field_accuracy": 0.92}, cases=10, failures=[], cost_cents=1)
    assert run.regressions(worse, {"field_accuracy": 0.95}, tolerance=0.02)


def test_missing_metric_is_a_regression() -> None:
    result = SuiteResult(metrics={}, cases=0, failures=[], cost_cents=0)
    assert run.regressions(result, {"pass_rate": 1.0}, tolerance=0.0) == [
        "pass_rate missing (baseline 1.0000)"
    ]


def write_baseline(path: Path, data: dict[str, dict[str, float]]) -> Path:
    path.write_text(json.dumps(data))
    return path


def test_cli_passes_when_results_meet_the_baseline(tmp_path: Path) -> None:
    baseline = write_baseline(tmp_path / "baseline.json", {"calc": {"pass_rate": 1.0}})
    argv = ["--suite", "calc", "--max-cost-cents", "0", "--baseline", str(baseline)]
    assert run.main(argv, registry=REGISTRY) == 0


def test_cli_fails_on_regression(tmp_path: Path) -> None:
    baseline = write_baseline(tmp_path / "baseline.json", {"rules": {"accuracy": 0.95}})
    argv = ["--suite", "rules", "--max-cost-cents", "0", "--baseline", str(baseline)]
    assert run.main(argv, registry=REGISTRY) == 1


def test_cli_fails_when_a_suite_has_no_baseline(tmp_path: Path) -> None:
    baseline = write_baseline(tmp_path / "baseline.json", {})
    argv = ["--suite", "calc", "--max-cost-cents", "0", "--baseline", str(baseline)]
    assert run.main(argv, registry=REGISTRY) == 1


def test_cli_stops_at_the_cost_cap(tmp_path: Path) -> None:
    baseline = write_baseline(tmp_path / "baseline.json", {"pricey": {"accuracy": 1.0}})
    registry = {"pricey": spending("pricey", cents=50)}
    argv = ["--suite", "pricey", "--max-cost-cents", "10", "--baseline", str(baseline)]
    assert run.main(argv, registry=registry) == 2


def test_cli_with_no_matching_suites_is_a_no_op(tmp_path: Path) -> None:
    baseline = write_baseline(tmp_path / "baseline.json", {})
    registry = {"calc": REGISTRY["calc"]}
    argv = ["--suite", "llm", "--max-cost-cents", "100", "--baseline", str(baseline)]
    assert run.main(argv, registry=registry) == 0


def test_update_baseline_writes_the_new_metrics(tmp_path: Path) -> None:
    baseline = write_baseline(tmp_path / "baseline.json", {"calc": {"pass_rate": 0.5}})
    argv = [
        "--suite",
        "free",
        "--max-cost-cents",
        "0",
        "--baseline",
        str(baseline),
        "--update-baseline",
    ]
    assert run.main(argv, registry=REGISTRY) == 0
    assert json.loads(baseline.read_text()) == {
        "calc": {"pass_rate": 1.0},
        "rules": {"accuracy": 0.9},
    }


def test_report_is_written_as_json(tmp_path: Path) -> None:
    baseline = write_baseline(tmp_path / "baseline.json", {"calc": {"pass_rate": 1.0}})
    report = tmp_path / "out" / "report.json"
    argv = [
        "--suite",
        "calc",
        "--max-cost-cents",
        "0",
        "--baseline",
        str(baseline),
        "--report",
        str(report),
    ]
    assert run.main(argv, registry=REGISTRY) == 0
    data = json.loads(report.read_text())
    assert data["suites"]["calc"]["metrics"] == {"pass_rate": 1.0}
    assert data["suites"]["calc"]["regressions"] == []


def test_the_committed_baseline_covers_every_registered_suite() -> None:
    baseline = json.loads(run.DEFAULT_BASELINE.read_text())
    assert set(baseline) == set(run.SUITES)


def test_free_suites_pass_against_the_committed_baseline() -> None:
    assert run.main(["--suite", "free", "--max-cost-cents", "0"]) == 0
