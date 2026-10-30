"""What a suite is and what it returns."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field


class CostCapExceeded(RuntimeError):
    """A suite tried to spend more than ``--max-cost-cents`` allows."""


class SuiteUnavailable(RuntimeError):
    """A suite cannot run here (for example, no API key); nothing was spent."""


class Budget:
    """The run's spending cap. LLM suites charge every call before reading its result."""

    def __init__(self, max_cents: float) -> None:
        self.max_cents = max_cents
        self.spent_cents = 0.0

    def charge(self, cents: float) -> None:
        self.spent_cents += cents
        if self.spent_cents > self.max_cents:
            raise CostCapExceeded(
                f"spent {self.spent_cents:.2f} cents, cap is {self.max_cents:.2f} cents"
            )


@dataclass(frozen=True)
class SuiteResult:
    # Scores in [0, 1]; higher is better. Compared with evals/baseline.json.
    metrics: dict[str, float]
    cases: int
    failures: list[str] = field(default_factory=list)
    cost_cents: float = 0.0
    # Per metric, the largest share of it one case decides (a case is one thing
    # the model gets right or wrong on its own: a field, a document, a merchant's
    # label). An LLM metric tolerates this much of a drop, or 2 points if more. A
    # metric left out is a share of ``cases``, worth ``1 / cases``.
    case_worth: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Suite:
    name: str
    # LLM suites cost money, need API keys and tolerate one case's worth or 2
    # points of drift, whichever is larger; deterministic suites tolerate none.
    llm: bool
    run: Callable[[Budget], SuiteResult]
