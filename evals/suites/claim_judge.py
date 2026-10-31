"""The claim judges the explain suites share (spec 008 rules 24a, 24b, 24d and 24e).

A claim judge reads one draft and answers whether it claims something is in
effect now that may not be: the chosen 401(k) rate (``judge_rate_claim``) or the
W-4 entries' withholding (``judge_withholding_claim``). A suite supplies a
``ClaimJudge``, the judge's call and the verdict's claim; the judging, the
calibration over hand-labeled items and the failure lines live here once.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from llm.gateway import LLMError
from llm.schemas import ClaimDraft


class Verdict(Protocol):
    """What every claim judge's verdict carries besides its claim."""

    @property
    def reason(self) -> str: ...

    @property
    def sentence(self) -> str | None: ...


class ClaimItem[RequestT](Protocol):
    """One hand-labeled calibration item: the judge's question and the expected answer."""

    @property
    def id(self) -> str: ...

    @property
    def draft(self) -> ClaimDraft: ...

    # Whether the draft makes the claim: the expected verdict.
    @property
    def claims(self) -> bool: ...

    @property
    def request(self) -> RequestT: ...


def _claim_label(claims: bool) -> str:
    return "a claim" if claims else "no claim"


@dataclass(frozen=True)
class ClaimJudge[RequestT, VerdictT: Verdict]:
    """One judge as a suite asks it: its name for failure lines ("rate-claim"), the
    claim in words ("the chosen rate is in effect"), its call (the gateway's method
    bound to the eval user) and its verdict's claim."""

    name: str
    claim: str
    ask: Callable[[RequestT], VerdictT]
    claims: Callable[[VerdictT], bool]

    def judged(self, request: RequestT) -> VerdictT | LLMError:
        """The verdict, or the error the call failed with: a failed call counts as a
        miss and the run goes on (spec 008 rules 24a and 24d)."""
        try:
            return self.ask(request)
        except LLMError as exc:
            return exc

    def failed(self, exc: LLMError) -> str:
        return f"the {self.name} judge failed: {type(exc).__name__}: {exc}"

    def framing_failure(self, case_id: str, request: RequestT) -> str | None:
        """The failure line for a final row the judge reads as making the claim, or
        whose judging failed; None when the row frames it right."""
        verdict = self.judged(request)
        if isinstance(verdict, LLMError):
            return f"{case_id}: {self.failed(verdict)}"
        if self.claims(verdict):
            return f"{case_id}: claims {self.claim}: {verdict.sentence!r}"
        return None

    def calibrate(self, items: Sequence[ClaimItem[RequestT]]) -> tuple[int, list[str]]:
        """How many items the judge reads as labeled, and a failure line for each miss."""
        matched = 0
        failures: list[str] = []
        for item in items:
            verdict = self.judged(item.request)
            if isinstance(verdict, LLMError):
                failures.append(f"judge {item.id}: {self.failed(verdict)}")
            elif self.claims(verdict) == item.claims:
                matched += 1
            else:
                failures.append(
                    f"judge {item.id}: labeled {_claim_label(item.claims)}, judged"
                    f" {_claim_label(self.claims(verdict))}:"
                    f" {verdict.sentence or item.draft.text!r} ({verdict.reason})"
                )
        return matched, failures
