"""Run eval suites and compare them with the committed baseline.

    uv run python -m evals.run --suite free --max-cost-cents 0
    uv run python -m evals.run --suite extraction --max-cost-cents 200

``--suite`` takes a suite name or an alias: ``free`` (deterministic suites),
``llm`` (suites that call Claude) or ``all``. It can be repeated.

Exit codes: 0 every metric meets its baseline; 1 a regression or a suite with
no baseline; 2 the cost cap was hit or the arguments are wrong.

Deterministic suites must match their baseline exactly; LLM suites may drop up
to 2 points. ``--update-baseline`` rewrites the baseline from this run; commit
that change on its own.
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from evals.suites import SUITES
from evals.suites.base import Budget, CostCapExceeded, Suite, SuiteResult

DEFAULT_BASELINE = Path(__file__).resolve().parent / "baseline.json"
DETERMINISTIC_TOLERANCE = 0.0
LLM_TOLERANCE = 0.02
ALIASES = {"free", "llm", "all"}


def select_suites(names: Sequence[str], registry: Mapping[str, Suite]) -> list[Suite]:
    selected: dict[str, Suite] = {}
    for name in names:
        if name == "all":
            matches = list(registry.values())
        elif name == "free":
            matches = [suite for suite in registry.values() if not suite.llm]
        elif name == "llm":
            matches = [suite for suite in registry.values() if suite.llm]
        elif name in registry:
            matches = [registry[name]]
        else:
            known = ", ".join(sorted({*registry, *ALIASES}))
            raise ValueError(f"unknown suite {name!r} (known: {known})")
        for suite in matches:
            selected.setdefault(suite.name, suite)
    return list(selected.values())


def regressions(result: SuiteResult, baseline: Mapping[str, float], tolerance: float) -> list[str]:
    found = []
    for metric, expected in baseline.items():
        actual = result.metrics.get(metric)
        if actual is None:
            found.append(f"{metric} missing (baseline {expected:.4f})")
        elif actual < expected - tolerance - 1e-12:
            found.append(f"{metric} {actual:.4f} < baseline {expected:.4f}")
    return found


def _parser(registry: Mapping[str, Suite]) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m evals.run", description=__doc__.split("\n")[0])
    parser.add_argument(
        "--suite",
        action="append",
        required=True,
        help=f"suite name or alias; one of {', '.join(sorted({*registry, *ALIASES}))}",
    )
    parser.add_argument(
        "--max-cost-cents",
        type=float,
        required=True,
        help="stop when the run's LLM spend would exceed this many cents",
    )
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--report", type=Path, help="also write the results as JSON here")
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="write this run's metrics into the baseline instead of comparing",
    )
    return parser


def main(argv: Sequence[str] | None = None, *, registry: Mapping[str, Suite] = SUITES) -> int:
    args = _parser(registry).parse_args(argv)
    try:
        suites = select_suites(args.suite, registry)
    except ValueError as exc:
        print(f"error: {exc}")
        return 2
    if not suites:
        print(f"no registered suites match {args.suite}; nothing to run")
        return 0

    baseline: dict[str, dict[str, float]] = (
        json.loads(args.baseline.read_text()) if args.baseline.exists() else {}
    )
    budget = Budget(args.max_cost_cents)
    report: dict[str, Any] = {"suites": {}}
    failed = False
    for suite in suites:
        try:
            result = suite.run(budget)
        except CostCapExceeded as exc:
            print(f"{suite.name}: stopped, {exc}")
            return 2
        tolerance = LLM_TOLERANCE if suite.llm else DETERMINISTIC_TOLERANCE
        if args.update_baseline:
            baseline[suite.name] = dict(result.metrics)
            found: list[str] = []
        elif suite.name not in baseline:
            found = [f"no baseline for {suite.name}: run with --update-baseline and commit it"]
        else:
            found = regressions(result, baseline[suite.name], tolerance)
        failed = failed or bool(found)
        metrics = ", ".join(f"{k}={v:.4f}" for k, v in sorted(result.metrics.items()))
        status = "REGRESSED" if found else "ok"
        print(
            f"{suite.name}: {status} ({result.cases} cases, {metrics}, "
            f"{result.cost_cents:.2f} cents)"
        )
        for line in [*found, *result.failures]:
            print(f"  {line}")
        report["suites"][suite.name] = {
            "metrics": result.metrics,
            "cases": result.cases,
            "failures": result.failures,
            "cost_cents": result.cost_cents,
            "regressions": found,
        }
    report["spent_cents"] = budget.spent_cents

    if args.update_baseline:
        args.baseline.write_text(json.dumps(baseline, indent=2, sort_keys=True) + "\n")
        print(f"baseline written to {args.baseline}")
    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
