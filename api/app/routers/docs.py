"""Uploading documents, extracting them and confirming what was read (specs 004, 005).

Nothing here parses, OCRs or sends a document anywhere: the API stores the
bytes and queues ``ingest.extract``; the worker does the reading. What the user
confirms is validated here and is the only thing stored.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated, Self

from fastapi import APIRouter, File, Form, UploadFile, status
from pydantic import BaseModel, ConfigDict, model_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app import ratelimit
from app.auth import CurrentUser
from app.deps import Now, UserSession
from app.errors import AppError, NotFound, error_responses
from app.routers.benefits import BenefitsPlanOut
from app.routers.pay_stubs import PayStubOut
from app.types import UtcDateTime
from calc.pay_stub import balance
from db.enums import (
    DocumentStatus,
    DocumentStatusReason,
    DocumentType,
    JobKind,
    JobStatus,
    PayFrequency,
    PlanKind,
)
from db.models import BenefitsChunk, BenefitsPlan, Document, Job, PayStub, Profile
from ingest import store
from ingest.chunk import chunk_words
from ingest.proposal import (
    BenefitsValues,
    PayStubValues,
    Proposal,
    RetirementValues,
    benefits_text,
)
from jobs import queue

router = APIRouter(prefix="/docs", tags=["docs"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# Room for the multipart boundaries and the type field around the file.
MULTIPART_OVERHEAD_BYTES = 64 * 1024
# Leading bytes decide the type, never the client's Content-Type (spec 004 rule 1).
SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"%PDF-", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
)
EXTRACTABLE = frozenset({DocumentType.PAY_STUB, DocumentType.BENEFITS})
CONFIRMABLE = frozenset({DocumentStatus.PROPOSED, DocumentStatus.MANUAL_ENTRY_REQUIRED})
REVIEWABLE = CONFIRMABLE
ACTIVE_JOB = frozenset({JobStatus.QUEUED, JobStatus.RUNNING})
LIST_LIMIT = 100


class DocumentCreated(BaseModel):
    document_id: uuid.UUID


class DocumentOut(BaseModel):
    id: uuid.UUID
    type: DocumentType
    status: DocumentStatus
    # Why the document is manual_entry_required or failed.
    status_reason: DocumentStatusReason | None
    redaction_count: int
    # Known once the document has been read.
    page_count: int | None
    uploaded_at: UtcDateTime
    confirmed_at: UtcDateTime | None
    # When the stored file was deleted (on confirm, on replace, or after 7 days unconfirmed).
    deleted_at: UtcDateTime | None
    # The upload that replaced this document (spec 004 rule 24). GET /docs lists
    # only documents without one, so it is set only on GET /docs/{id}.
    replaced_by_id: uuid.UUID | None


class DocumentDetail(DocumentOut):
    # What was read, for review: set while proposed or manual_entry_required.
    proposal: Proposal | None


class ExtractionQueued(BaseModel):
    job_id: uuid.UUID


class ConfirmIn(BaseModel):
    """Exactly one of ``pay_stub`` or ``benefits``, matching the document's type."""

    model_config = ConfigDict(extra="forbid")

    pay_stub: PayStubValues | None = None
    benefits: BenefitsValues | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> Self:
        if (self.pay_stub is None) == (self.benefits is None):
            raise ValueError("give exactly one of pay_stub or benefits")
        return self


class Confirmed(BaseModel):
    document: DocumentOut
    pay_stub: PayStubOut | None
    plans: list[BenefitsPlanOut]
    # True when a benefits confirm wrote the 401(k) match and vesting to the profile.
    profile_updated: bool


def _out(document: Document) -> DocumentOut:
    return DocumentOut(
        id=document.id,
        type=document.type,
        status=document.status,
        status_reason=document.status_reason,
        redaction_count=document.redaction_count,
        page_count=document.page_count,
        uploaded_at=document.created_at,
        confirmed_at=document.confirmed_at,
        deleted_at=document.deleted_at,
        replaced_by_id=document.replaced_by_id,
    )


def _sniff(data: bytes) -> str:
    for signature, content_type in SIGNATURES:
        if data.startswith(signature):
            return content_type
    raise AppError("Upload a PDF, PNG or JPEG", code="unsupported_media_type", status_code=415)


def _for_update(session: UserSession, document_id: uuid.UUID) -> Document:
    """The user's document, locked; 404 when RLS hides it or it does not exist."""
    document = session.scalars(
        select(Document).where(Document.id == document_id).with_for_update()
    ).one_or_none()
    if document is None:
        raise NotFound("Document not found")
    if document.replaced_by_id is not None:
        raise AppError(
            "This document was replaced by a newer upload",
            code="document_replaced",
            status_code=409,
        )
    return document


def _locked(session: UserSession, document_id: uuid.UUID) -> Document:
    document = _for_update(session, document_id)
    if document.status is DocumentStatus.CONFIRMED:
        raise AppError(
            "This document is already confirmed", code="document_confirmed", status_code=409
        )
    if document.deleted_at is not None:
        raise AppError(
            "This document's file was deleted; upload it again",
            code="document_deleted",
            status_code=409,
        )
    return document


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    responses=error_responses(401, 404, 409, 413, 415, 422, 429),
)
def upload_document(
    file: Annotated[UploadFile, File(description="A PDF, PNG or JPEG of at most 10 MB")],
    document_type: Annotated[DocumentType, Form(alias="type")],
    session: UserSession,
    user: CurrentUser,
    now: Now,
    replaces: Annotated[
        uuid.UUID | None,
        Form(description="A document of the same type that this upload replaces"),
    ] = None,
) -> DocumentCreated:
    """Store an uploaded document for extraction, retiring the one it replaces."""
    ratelimit.consume(session, user.id, ratelimit.UPLOADS, now=now)
    replaced = _replaceable(session, replaces, document_type) if replaces is not None else None
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if not data:
        raise AppError("The file is empty", code="empty_file", status_code=422)
    if len(data) > MAX_UPLOAD_BYTES:
        raise AppError("The file is larger than 10 MB", code="file_too_large", status_code=413)
    content_type = _sniff(data)
    document = Document(
        user_id=user.id, type=document_type, content_type=content_type, size_bytes=len(data)
    )
    session.add(document)
    session.flush()
    store.put(
        session, document_id=document.id, user_id=user.id, data=data, content_type=content_type
    )
    if replaced is not None:
        _retire(session, replaced, replaced_by=document, now=now)
    return DocumentCreated(document_id=document.id)


def _replaceable(
    session: UserSession, document_id: uuid.UUID, document_type: DocumentType
) -> Document:
    """The document an upload names in ``replaces``, locked so a concurrent
    replacement waits and then sees it replaced (spec 004 rules 24 and 29)."""
    document = _for_update(session, document_id)
    if document.type is not document_type:
        raise AppError(
            f"A {document_type.value} upload cannot replace a {document.type.value} document",
            code="replace_type_mismatch",
            status_code=422,
        )
    return document


def _retire(
    session: UserSession, document: Document, *, replaced_by: Document, now: dt.datetime
) -> None:
    """Spec 004 rules 25-26: the file and the proposal go, the row and whatever
    was confirmed from it stay."""
    store.delete(session, document.id)
    if document.deleted_at is None:
        document.deleted_at = now
    document.proposal = None
    document.replaced_by_id = replaced_by.id


@router.get("", responses=error_responses(401))
def list_documents(session: UserSession) -> list[DocumentOut]:
    """The user's documents that have not been replaced, newest first."""
    documents = session.scalars(
        select(Document)
        .where(Document.replaced_by_id.is_(None))
        .order_by(Document.created_at.desc(), Document.id.desc())
        .limit(LIST_LIMIT)
    )
    return [_out(document) for document in documents]


@router.get("/{document_id}", responses=error_responses(401, 404, 422))
def get_document(document_id: uuid.UUID, session: UserSession) -> DocumentDetail:
    """One document, with its proposal while it is being reviewed."""
    document = session.get(Document, document_id)
    if document is None:
        raise NotFound("Document not found")
    proposal = (
        Proposal.stored(document.proposal, document.type.value)
        if document.status in REVIEWABLE and document.proposal is not None
        else None
    )
    return DocumentDetail(**_out(document).model_dump(), proposal=proposal)


@router.post(
    "/{document_id}/extract",
    status_code=status.HTTP_202_ACCEPTED,
    responses=error_responses(401, 404, 409, 422, 429),
)
def extract_document(
    document_id: uuid.UUID, session: UserSession, user: CurrentUser, now: Now
) -> ExtractionQueued:
    """Queue reading the document; returns the running job while one is in flight."""
    ratelimit.consume(session, user.id, ratelimit.EXTRACTIONS, now=now)
    document = _locked(session, document_id)
    if document.type not in EXTRACTABLE:
        raise AppError(
            f"{document.type.value} documents cannot be extracted yet",
            code="extraction_unsupported",
            status_code=422,
        )
    if document.status is DocumentStatus.EXTRACTING and document.extract_job_id is not None:
        job = session.get(Job, document.extract_job_id)
        if job is not None and job.status in ACTIVE_JOB:
            return ExtractionQueued(job_id=job.id)
    job_id = queue.enqueue(
        session,
        user_id=user.id,
        kind=JobKind.INGEST_EXTRACT,
        payload={"document_id": str(document.id)},
    )
    document.status = DocumentStatus.EXTRACTING
    document.status_reason = None
    document.extract_job_id = job_id
    return ExtractionQueued(job_id=job_id)


@router.post("/{document_id}/confirm", responses=error_responses(401, 404, 409, 422))
def confirm_document(
    document_id: uuid.UUID, body: ConfirmIn, session: UserSession, user: CurrentUser, now: Now
) -> Confirmed:
    """Store the values the user checked, then delete the uploaded file."""
    document = _locked(session, document_id)
    if document.status not in CONFIRMABLE:
        raise AppError(
            "This document has not been read yet", code="document_not_ready", status_code=409
        )
    stub: PayStub | None = None
    plans: list[BenefitsPlan] = []
    profile_updated = False
    if document.type is DocumentType.PAY_STUB and body.pay_stub is not None:
        stub = _pay_stub(document, body.pay_stub)
        session.add(stub)
    elif document.type is DocumentType.BENEFITS and body.benefits is not None:
        plans = _plans(document, body.benefits)
        session.add_all(plans)
        session.add_all(_chunks(document))
        if body.benefits.retirement is not None:
            _save_retirement(session, document.user_id, body.benefits.retirement)
            profile_updated = True
    else:
        raise AppError(
            f"This is a {document.type.value} document; send its values under"
            f" {document.type.value!r}",
            code="wrong_document_type",
            status_code=422,
        )
    store.delete(session, document.id)
    document.status = DocumentStatus.CONFIRMED
    document.status_reason = None
    document.confirmed_at = now
    document.deleted_at = now
    session.flush()
    if stub is not None:
        session.refresh(stub)  # tax_year is generated by the database
    return Confirmed(
        document=_out(document),
        pay_stub=PayStubOut.of(stub) if stub is not None else None,
        plans=[BenefitsPlanOut.of(plan) for plan in plans],
        profile_updated=profile_updated,
    )


def _pay_stub(document: Document, values: PayStubValues) -> PayStub:
    result = balance(values.amounts())
    if not result.balances:
        raise AppError(
            f"Gross minus deductions is {result.expected_net_cents} cents, but net is"
            f" {result.net_cents} cents",
            code="pay_stub_unbalanced",
            status_code=422,
            details=result.model_dump(),
        )
    fields = values.model_dump()
    frequency = fields.pop("pay_frequency")
    return PayStub(
        user_id=document.user_id,
        document_id=document.id,
        pay_frequency=PayFrequency(frequency) if frequency is not None else None,
        **fields,
    )


def _plans(document: Document, values: BenefitsValues) -> list[BenefitsPlan]:
    plans = []
    for position, plan in enumerate(values.plans):
        fields = plan.model_dump()
        kind = PlanKind(fields.pop("kind"))
        plans.append(
            BenefitsPlan(
                user_id=document.user_id,
                document_id=document.id,
                position=position,
                kind=kind,
                **fields,
            )
        )
    return plans


def _save_retirement(session: UserSession, user_id: uuid.UUID, values: RetirementValues) -> None:
    """Write the confirmed match and vesting; every other profile field is kept
    (spec 013 rule 13)."""
    columns = {
        # jsonb holds JSON: percentages as two-place strings, as PUT /profile writes them.
        "match_tiers": [tier.model_dump(mode="json") for tier in values.match_tiers],
        "vesting_years": values.vesting_years,
    }
    session.execute(
        insert(Profile)
        .values(user_id=user_id, **columns)
        .on_conflict_do_update(index_elements=[Profile.user_id], set_=columns)
    )


def _chunks(document: Document) -> list[BenefitsChunk]:
    """Retrieval chunks of the redacted text the user reviewed (spec 005 rule 22)."""
    if document.proposal is None:
        return []
    text = benefits_text(Proposal.stored(document.proposal, document.type.value))
    return [
        BenefitsChunk(
            user_id=document.user_id, document_id=document.id, chunk_index=index, text=chunk
        )
        for index, chunk in enumerate(chunk_words(text))
    ]
