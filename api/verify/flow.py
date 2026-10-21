"""Draft, verify, retry once with the failure attached, then fall back
(spec 008 rules 15-16). Pure orchestration: the caller stores the attempts.

A gateway error (``LLMError``: a spent budget, a refusal, a schema error, an
unreachable API) ends the run at once with the fallback; nothing is retried
after a refusal or a spent budget. Any other exception is a bug and propagates.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Collection
from dataclasses import dataclass
from typing import Protocol

from llm.gateway import LLMError
from llm.schemas import ExplainContext, ExplanationDraft
from verify.allowed import AllowedNumbers
from verify.verify import Verification, verify_explanation

__all__ = ["MAX_DRAFTS", "Attempt", "Drafter", "run_explain"]

log = logging.getLogger(__name__)

# One draft and one retry.
MAX_DRAFTS = 2


class Drafter(Protocol):
    def explain(
        self, user_id: uuid.UUID, context: ExplainContext, *, feedback: str | None = None
    ) -> ExplanationDraft: ...


@dataclass(frozen=True)
class Attempt:
    """One row of the run: a drafted attempt, or the closing fallback."""

    attempt: int
    # Retries made in this run so far (0 or 1).
    retries: int
    draft: ExplanationDraft
    verification: Verification
    fallback: bool

    @property
    def verified(self) -> bool:
        return not self.fallback and self.verification.passed


def run_explain(
    drafter: Drafter,
    user_id: uuid.UUID,
    context: ExplainContext,
    allowed_numbers: AllowedNumbers,
    allowed_citation_keys: Collection[str],
    fallback: ExplanationDraft,
) -> list[Attempt]:
    attempts: list[Attempt] = []
    feedback: str | None = None
    calls = 0
    for number in range(1, MAX_DRAFTS + 1):
        calls += 1
        try:
            draft = drafter.explain(user_id, context, feedback=feedback)
        except LLMError as exc:
            log.warning("explain attempt %d failed: %s", number, type(exc).__name__)
            break
        verification = verify_explanation(draft, allowed_numbers, allowed_citation_keys)
        attempts.append(
            Attempt(
                attempt=number,
                retries=calls - 1,
                draft=draft,
                verification=verification,
                fallback=False,
            )
        )
        if verification.passed:
            return attempts
        feedback = verification.feedback()
    attempts.append(
        Attempt(
            attempt=len(attempts) + 1,
            retries=calls - 1,
            draft=fallback,
            verification=verify_explanation(fallback, allowed_numbers, allowed_citation_keys),
            fallback=True,
        )
    )
    return attempts
