"""The live gateway an LLM suite runs on: the real model, every call charged to the
run's ``Budget`` before its result is read (evals/CLAUDE.md)."""

from __future__ import annotations

from dataclasses import dataclass, field

from app.config import Settings
from evals.suites.base import Budget, SuiteUnavailable
from llm.gateway import MICROCENTS_PER_CENT, Gateway, LedgerEntry, LLMGateway, MemoryLedger

# The gateway's per-user daily cap is not the eval's limit: --max-cost-cents is.
UNCAPPED_DAILY_CENTS = 1_000_000


def _settings() -> Settings:
    return Settings()


def _gateway(settings: Settings, ledger: MemoryLedger) -> Gateway:
    return LLMGateway(settings, ledger=ledger)


@dataclass(frozen=True)
class LiveGateway:
    """The gateway and what its calls have cost so far."""

    gateway: Gateway
    _spent: list[float] = field(default_factory=list)

    @property
    def spent_cents(self) -> float:
        return sum(self._spent)


def live_gateway(budget: Budget) -> LiveGateway:
    """A gateway on the real model whose ledger charges ``budget`` for each call.
    Raises ``SuiteUnavailable`` without ``ANTHROPIC_API_KEY``, before anything is spent."""
    settings = _settings()
    if settings.anthropic_api_key is None:
        raise SuiteUnavailable("ANTHROPIC_API_KEY is not set")
    spent: list[float] = []

    def charge(entry: LedgerEntry) -> None:
        cents = entry.cost_microcents / MICROCENTS_PER_CENT
        spent.append(cents)
        budget.charge(cents)

    gateway = _gateway(
        settings.model_copy(
            update={"llm_fake": False, "llm_daily_budget_cents": UNCAPPED_DAILY_CENTS}
        ),
        MemoryLedger(on_record=charge),
    )
    return LiveGateway(gateway, spent)
