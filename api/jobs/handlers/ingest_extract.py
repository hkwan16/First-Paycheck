"""``ingest.extract``: read, redact and extract one uploaded document (spec 005
rules 10-15). Worker only.

The blob is read in one short user session; OCR, redaction and the model call
run with no transaction open; the outcome is written in a second session, and
only while the document is still ``extracting`` under this job, so a newer
request or a confirm in the meantime wins.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol, TypeGuard

from sqlalchemy import select

from db.enums import DocumentStatus, DocumentStatusReason, DocumentType
from db.models import Document
from ingest import store
from ingest.pipeline import PreparedDocument, prepare_document
from ingest.proposal import (
    Proposal,
    benefits_proposal,
    manual_entry_proposal,
    pay_stub_proposal,
)
from ingest.reader import UnreadableDocument
from jobs.context import JobContext
from jobs.queue import MAX_ATTEMPTS
from llm.gateway import LLMBudgetExceeded, LLMError, LLMRefused, ModelPage
from llm.schemas import BenefitsExtraction, PayStubExtraction

SKIPPED: dict[str, Any] = {"status": "skipped"}


class DocumentExtractor(Protocol):
    """What the job needs from the LLM gateway."""

    def extract_pay_stub(
        self, user_id: uuid.UUID, pages: Sequence[ModelPage], *, job_id: uuid.UUID | None = None
    ) -> PayStubExtraction: ...

    def extract_benefits(
        self, user_id: uuid.UUID, pages: Sequence[ModelPage], *, job_id: uuid.UUID | None = None
    ) -> BenefitsExtraction: ...


@dataclass(frozen=True)
class _Outcome:
    status: DocumentStatus
    reason: DocumentStatusReason | None = None
    proposal: Proposal | None = None
    prepared: PreparedDocument | None = None


def run(ctx: JobContext) -> dict[str, Any]:
    extractor = ctx.services.extractor
    if extractor is None:
        raise RuntimeError("no LLM gateway is configured for this worker")
    document_id = uuid.UUID(str(ctx.job.payload["document_id"]))

    with ctx.user_session() as session:
        document = session.get(Document, document_id)
        if not _is_current(document, ctx.job.id):
            return SKIPPED
        document_type = document.type
        blob = store.get(session, document_id)
    if blob is None:
        return SKIPPED
    ctx.progress(10)

    outcome = _extract(ctx, extractor, document_type, blob.data, blob.content_type)

    with ctx.user_session() as session:
        document = session.execute(
            select(Document).where(Document.id == document_id).with_for_update()
        ).scalar_one_or_none()
        if not _is_current(document, ctx.job.id):
            return SKIPPED
        prepared = outcome.prepared
        document.status = outcome.status
        document.status_reason = outcome.reason
        if outcome.proposal is not None:
            document.proposal = outcome.proposal.model_dump(mode="json")
        if prepared is not None:
            document.page_count = prepared.page_count
            document.redaction_count = prepared.redaction_count
    return {
        "document_id": str(document_id),
        "status": outcome.status.value,
        "page_count": prepared.page_count if prepared else None,
        "redaction_count": prepared.redaction_count if prepared else 0,
        "withheld_pages": prepared.withheld_pages if prepared else [],
    }


def _is_current(document: Document | None, job_id: uuid.UUID) -> TypeGuard[Document]:
    return (
        document is not None
        and document.status is DocumentStatus.EXTRACTING
        and document.extract_job_id == job_id
    )


def _extract(
    ctx: JobContext,
    extractor: DocumentExtractor,
    document_type: DocumentType,
    data: bytes,
    content_type: str,
) -> _Outcome:
    try:
        prepared = prepare_document(data, content_type)
    except UnreadableDocument:
        return _Outcome(DocumentStatus.FAILED, DocumentStatusReason.UNREADABLE_FILE)
    ctx.progress(40)

    def manual(reason: DocumentStatusReason) -> _Outcome:
        proposal = manual_entry_proposal(document_type, prepared.pages, prepared.withheld_pages)
        return _Outcome(DocumentStatus.MANUAL_ENTRY_REQUIRED, reason, proposal, prepared)

    pages = prepared.model_pages
    if not pages:
        return manual(DocumentStatusReason.NO_READABLE_PAGE)
    try:
        proposal = _propose(ctx, extractor, document_type, prepared)
    except LLMRefused:
        return manual(DocumentStatusReason.REFUSED)
    except LLMBudgetExceeded:
        return manual(DocumentStatusReason.BUDGET)
    except LLMError:
        # Schema and API errors retry (spec 002 rule 34); the last attempt
        # hands the document to the user instead of leaving it stuck.
        if ctx.job.attempts < MAX_ATTEMPTS:
            raise
        return manual(DocumentStatusReason.EXTRACTION_FAILED)
    return _Outcome(DocumentStatus.PROPOSED, None, proposal, prepared)


def _propose(
    ctx: JobContext,
    extractor: DocumentExtractor,
    document_type: DocumentType,
    prepared: PreparedDocument,
) -> Proposal:
    pages, withheld = prepared.model_pages, prepared.withheld_pages
    if document_type is DocumentType.PAY_STUB:
        stub = extractor.extract_pay_stub(ctx.user_id, pages, job_id=ctx.job.id)
        return pay_stub_proposal(stub, prepared.pages, withheld)
    if document_type is DocumentType.BENEFITS:
        benefits = extractor.extract_benefits(ctx.user_id, pages, job_id=ctx.job.id)
        return benefits_proposal(benefits, prepared.pages, withheld)
    raise ValueError(f"ingest.extract does not support {document_type.value} documents")
