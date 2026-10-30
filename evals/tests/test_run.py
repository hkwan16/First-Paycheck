"""The eval runner: suite selection, cost cap, baseline comparison and the CLI."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evals import run
from evals.suites.base import Budget, CostCapExceeded, Suite, SuiteResult, SuiteUnavailable


def fixed(
    name: str,
    *,
    llm: bool = False,
    cases: int = 100,
    case_worth: dict[str, float] | None = None,
    **metrics: float,
) -> Suite:
    def execute(budget: Budget) -> SuiteResult:
        return SuiteResult(
            metrics=dict(metrics), cases=cases, case_worth=dict(case_worth or {}), cost_cents=0
        )

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
    result = SuiteResult(metrics={"pass_rate": 0.99}, cases=5, failures=[], cost_cents=0)
    tolerances = run.tolerances(result, llm=False)
    assert tolerances == {"pass_rate": 0.0}
    assert run.regressions(result, {"pass_rate": 1.0}, tolerances) == [
        "pass_rate 0.9900 < baseline 1.0000 (tolerance 0.0000)"
    ]


def test_llm_suites_allow_two_points() -> None:
    result = SuiteResult(metrics={"field_accuracy": 0.935}, cases=100, failures=[], cost_cents=1)
    tolerances = run.tolerances(result, llm=True)
    assert tolerances == {"field_accuracy": 0.02}
    assert run.regressions(result, {"field_accuracy": 0.95}, tolerances) == []
    worse = SuiteResult(metrics={"field_accuracy": 0.92}, cases=100, failures=[], cost_cents=1)
    assert run.regressions(worse, {"field_accuracy": 0.95}, tolerances)


def test_an_llm_metric_over_few_cases_allows_one_case() -> None:
    result = SuiteResult(metrics={"document_accuracy": 0.8}, cases=5)
    assert run.tolerances(result, llm=True) == {"document_accuracy": pytest.approx(0.2)}


def test_a_reported_case_worth_replaces_one_over_cases() -> None:
    result = SuiteResult(
        metrics={"accuracy": 0.9, "llm_accuracy": 0.9, "rules": 1.0},
        cases=528,
        case_worth={"accuracy": 14 / 528, "llm_accuracy": 14 / 114},
    )
    assert run.tolerances(result, llm=True) == {
        "accuracy": pytest.approx(14 / 528),
        "llm_accuracy": pytest.approx(14 / 114),
        "rules": 0.02,
    }


def test_a_metric_over_no_cases_gets_the_two_point_floor() -> None:
    result = SuiteResult(metrics={"recall": 1.0}, cases=0, case_worth={"recall": 0.0})
    assert run.tolerances(result, llm=True) == {"recall": 0.02}
    assert run.tolerances(SuiteResult(metrics={"recall": 1.0}, cases=0), llm=True) == {
        "recall": 0.02
    }


def test_missing_metric_is_a_regression() -> None:
    result = SuiteResult(metrics={}, cases=0, failures=[], cost_cents=0)
    assert run.regressions(result, {"pass_rate": 1.0}, run.tolerances(result, llm=False)) == [
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


def test_cli_reports_an_unavailable_suite(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def execute(budget: Budget) -> SuiteResult:
        raise SuiteUnavailable("ANTHROPIC_API_KEY is not set")

    baseline = write_baseline(tmp_path / "baseline.json", {"keyed": {"accuracy": 1.0}})
    registry = {"keyed": Suite(name="keyed", llm=True, run=execute)}
    argv = ["--suite", "keyed", "--max-cost-cents", "10", "--baseline", str(baseline)]
    assert run.main(argv, registry=registry) == 2
    assert "keyed: unavailable, ANTHROPIC_API_KEY is not set" in capsys.readouterr().out


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
    assert data["suites"]["calc"]["tolerances"] == {"pass_rate": 0.0}
    assert data["suites"]["calc"]["regressions"] == []


def run_one(tmp_path: Path, suite: Suite, baseline: float) -> int:
    """The CLI's exit code for ``suite`` against a baseline of ``baseline``."""
    path = write_baseline(tmp_path / "baseline.json", {suite.name: {"score": baseline}})
    argv = ["--suite", suite.name, "--max-cost-cents", "0", "--baseline", str(path)]
    return run.main(argv, registry={suite.name: suite})


def test_cli_holds_deterministic_suites_at_tolerance_zero(tmp_path: Path) -> None:
    """The plan: deterministic suites are compared with tolerance 0."""
    assert run.DETERMINISTIC_TOLERANCE == 0.0
    assert run_one(tmp_path, fixed("rules", score=0.9), baseline=0.9) == 0
    assert run_one(tmp_path, fixed("rules", score=0.9), baseline=0.9001) == 1
    # An improvement passes; the baseline is raised in its own commit.
    assert run_one(tmp_path, fixed("rules", score=0.95), baseline=0.9) == 0


def test_cli_gives_llm_suites_two_points(tmp_path: Path) -> None:
    """The plan: LLM suites are compared with a tolerance of at least 2 points."""
    assert run.LLM_TOLERANCE == 0.02
    assert run_one(tmp_path, fixed("judge", llm=True, score=0.88), baseline=0.9) == 0
    assert run_one(tmp_path, fixed("judge", llm=True, score=0.8799), baseline=0.9) == 1
    # The same drop in a deterministic suite is a regression.
    assert run_one(tmp_path, fixed("rules", score=0.88), baseline=0.9) == 1


def test_cli_gives_an_llm_metric_over_few_cases_one_case(tmp_path: Path) -> None:
    """Over 5 cases one case is 20 points: one miss from a perfect baseline passes,
    a second fails."""
    assert run_one(tmp_path, fixed("judge", llm=True, cases=5, score=0.8), baseline=1.0) == 0
    assert run_one(tmp_path, fixed("judge", llm=True, cases=5, score=0.6), baseline=1.0) == 1
    # A deterministic suite over 5 cases still tolerates nothing.
    assert run_one(tmp_path, fixed("rules", cases=5, score=0.8), baseline=1.0) == 1


def test_cli_uses_the_case_worth_a_suite_reports(tmp_path: Path) -> None:
    """One label covers 14 of the 114 rows the model labels: losing it passes,
    losing one row more fails, though the suite has 528 cases."""

    def labels(score: float) -> Suite:
        return fixed("labels", llm=True, cases=528, case_worth={"score": 14 / 114}, score=score)

    assert run_one(tmp_path, labels(1 - 14 / 114), baseline=1.0) == 0
    assert run_one(tmp_path, labels(1 - 15 / 114), baseline=1.0) == 1


def test_a_stopped_run_still_writes_its_report(tmp_path: Path) -> None:
    """The nightly workflow reads the report even when the cap stops the run."""
    baseline = write_baseline(
        tmp_path / "baseline.json", {"calc": {"pass_rate": 1.0}, "pricey": {"accuracy": 1.0}}
    )
    report = tmp_path / "report.json"
    registry = {"calc": REGISTRY["calc"], "pricey": spending("pricey", cents=50)}
    argv = ["--suite", "all", "--max-cost-cents", "10", "--baseline", str(baseline)]
    assert run.main([*argv, "--report", str(report)], registry=registry) == 2
    data = json.loads(report.read_text())
    assert data["suites"]["calc"]["regressions"] == []
    assert data["stopped"] == "pricey: stopped, spent 50.00 cents, cap is 10.00 cents"


def test_the_committed_baseline_covers_every_registered_suite() -> None:
    baseline = json.loads(run.DEFAULT_BASELINE.read_text())
    assert set(baseline) == set(run.SUITES)


def test_free_suites_pass_against_the_committed_baseline() -> None:
    assert run.main(["--suite", "free", "--max-cost-cents", "0"]) == 0
