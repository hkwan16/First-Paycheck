"""Explanations of saved decisions (spec 008 rules 15-23).

``POST /explain`` reads the decision and its context in one short user
session, runs the draft-verify-retry flow with no transaction open, then
writes every attempt in a second session. Nothing is shown unverified: the
final row is either a verified draft or the code-written fallback.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import ratelimit
from app.auth import CurrentUser
from app.deps import LlmGateway, Now, UserSession, UserSessions
from app.errors import AppError, NotFound, error_responses
from app.routers.pay_stubs import newest_pay_stub_rate
from app.types import UtcDateTime
from db.enums import CalculatorKind
from db.models import Decision, Explanation
from llm.gateway import EXPLAIN_PROMPT
from llm.prompts import load_prompt
from llm.schemas import NumberClaim
from retrieval import benefits_search
from retrieval.citations import Citation, by_key, for_calculator
from retrieval.context import BENEFITS_PASSAGES, BENEFITS_QUERIES, explain_setup
from verify.fallback import FALLBACK_VERSION
from verify.flow import Attempt, run_explain

router = APIRouter(tags=["explain"])


class ExplainIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision_id: uuid.UUID
    # Draft a new explanation even when a verified one exists.
    force: bool = False


class CitationOut(BaseModel):
    key: str
    title: str
    url: str
    passage: str
    source: str


class VerificationOut(BaseModel):
    numbers_checked: int
    numbers_unmatched: list[str]
    citations_checked: int
    citations_unknown: list[str]
    has_citation: bool


class ExplanationOut(BaseModel):
    id: uuid.UUID
    decision_id: uuid.UUID
    concept: str
    text: str
    numbers: list[NumberClaim]
    what_ifs: list[str]
    citations: list[CitationOut]
    verified: bool
    fallback: bool
    attempt: int
    retries: int
    prompt_version: str
    verification: VerificationOut
    created_at: UtcDateTime


def _decision(session: Session, decision_id: uuid.UUID) -> Decision:
    decision = session.get(Decision, decision_id)
    if decision is None:
        raise NotFound("Decision not found")
    return decision


def _benefits_query(decision: Decision) -> str:
    """The calculator's benefits query; a calculator without one has no explanation yet."""
    query = BENEFITS_QUERIES.get(CalculatorKind(decision.calculator))
    if query is None:
        raise AppError(
            f"{decision.calculator} decisions cannot be explained yet",
            code="explanation_unavailable",
            status_code=422,
        )
    return query


def _tax_year(decision: Decision) -> int:
    return int(decision.inputs["tax_year"])


def _out(row: Explanation, decision_id: uuid.UUID, citations: list[Citation]) -> ExplanationOut:
    return ExplanationOut(
        id=row.id,
        decision_id=decision_id,
        concept=row.concept,
        text=row.text,
        numbers=[NumberClaim.model_validate(claim) for claim in row.numbers],
        what_ifs=list(row.what_ifs),
        citations=[
            CitationOut(
                key=citation.key,
                title=citation.title,
                url=citation.url,
                passage=citation.passage,
                source=citation.source,
            )
            for citation in by_key(citations, row.citations)
        ],
        verified=row.verified,
        fallback=row.fallback,
        attempt=row.attempt,
        retries=row.retries,
        prompt_version=row.prompt_version,
        verification=VerificationOut.model_validate(row.verification),
        created_at=row.created_at,
    )


def _latest(session: Session, decision_id: uuid.UUID, *, verified: bool) -> Explanation | None:
    """Rule 19: the row with the greatest (created_at, attempt)."""
    statement = select(Explanation).where(Explanation.decision_id == decision_id)
    if verified:
        statement = statement.where(Explanation.verified)
    return session.scalars(
        statement.order_by(Explanation.created_at.desc(), Explanation.attempt.desc()).limit(1)
    ).first()


def _row(user_id: uuid.UUID, decision_id: uuid.UUID, attempt: Attempt) -> Explanation:
    draft = attempt.draft
    prompt_version = FALLBACK_VERSION if attempt.fallback else load_prompt(*EXPLAIN_PROMPT).version
    return Explanation(
        user_id=user_id,
        decision_id=decision_id,
        attempt=attempt.attempt,
        retries=attempt.retries,
        concept=draft.concept,
        text=draft.text,
        numbers=[claim.model_dump(mode="json") for claim in draft.numbers],
        what_ifs=list(draft.what_ifs),
        citations=list(draft.citation_keys),
        prompt_version=prompt_version,
        verified=attempt.verified,
        fallback=attempt.fallback,
        verification=attempt.verification.as_json(),
    )


@router.post("/explain", responses=error_responses(401, 404, 422, 429, 503))
def explain(
    body: ExplainIn, user: CurrentUser, sessions: UserSessions, gateway: LlmGateway, now: Now
) -> ExplanationOut:
    """Explain a decision; returns the existing verified explanation unless ``force``."""
    with sessions() as session:
        decision = _decision(session, body.decision_id)
        query = _benefits_query(decision)
        citations = for_calculator(session, decision.calculator, _tax_year(decision))
        if not body.force:
            existing = _latest(session, decision.id, verified=True)
            if existing is not None:
                return _out(existing, decision.id, citations)
        # A run is about to start: a missing model is 503 before it counts, and
        # a refused run rolls its increment back with this session (rule 22).
        model = gateway()
        ratelimit.consume(session, user.id, ratelimit.EXPLAIN_RUNS, now=now)
        passages = benefits_search.search(session, user.id, query, BENEFITS_PASSAGES)
        # What goes into the 401(k) now, beside the rate the decision chose (rule 7a).
        pay_stub_pct = newest_pay_stub_rate(session)
    inputs: dict[str, Any] = decision.inputs
    result: dict[str, Any] = decision.result
    setup = explain_setup(
        decision.calculator, inputs, result, citations, passages, pay_stub_pct=pay_stub_pct
    )
    # The model call runs with no session open (rule 21).
    attempts = run_explain(
        model,
        user.id,
        setup.context,
        setup.allowed_numbers,
        setup.citation_keys,
        setup.fallback,
    )
    with sessions() as session:
        rows = [_row(user.id, decision.id, attempt) for attempt in attempts]
        session.add_all(rows)
        session.flush()
        return _out(rows[-1], decision.id, citations)


@router.get("/decisions/{decision_id}/explanation", responses=error_responses(401, 404))
def get_explanation(decision_id: uuid.UUID, session: UserSession) -> ExplanationOut:
    """The decision's latest explanation; 404 when it has none."""
    decision = _decision(session, decision_id)
    row = _latest(session, decision.id, verified=False)
    if row is None:
        raise NotFound("This decision has no explanation yet")
    citations = for_calculator(session, decision.calculator, _tax_year(decision))
    return _out(row, decision.id, citations)
