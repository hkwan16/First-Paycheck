"""The extraction-smoke suite (free, spec 005 rule 27): the document pipeline
end to end over the 10 labeled stubs, with ``FakeGateway`` in place of the
model, so it costs nothing and runs on every ``make eval``.

What it checks is what the model would receive. Text pages are searched
directly; image pages, which the model sees as pictures, are OCR'd again from
the redacted PNG, so a black box that missed a digit shows up here.

Metrics (deterministic, no drop tolerated):

- ``pipeline_ok``: the share of stubs that produce a proposal.
- ``redaction_recall``: of the stubs that print an SSN in full, the share
  whose ``redaction_count`` is non-zero.
- ``ssn_free``: the share of stubs whose model input holds neither the
  labeled SSN nor the unmasked account number.

Needs the tesseract binary, like the worker.
"""

from __future__ import annotations

import io
import re
from collections.abc import Sequence

from PIL import Image

from app.config import Settings
from evals.gen.make_pay_stubs import Fixture, load_fixtures
from evals.suites.base import Budget, Suite, SuiteResult
from evals.suites.extraction import EVAL_USER
from ingest.ocr import ocr_image
from ingest.pipeline import prepare_document
from ingest.proposal import pay_stub_proposal
from llm.gateway import FakeGateway, ImagePage, MemoryLedger, ModelPage


def model_input_text(pages: Sequence[ModelPage]) -> str:
    """Everything the model would read: text pages as sent, image pages re-OCR'd."""
    parts = []
    for page in pages:
        if isinstance(page, ImagePage):
            lines = ocr_image(Image.open(io.BytesIO(page.png)).convert("RGB")).lines
            parts.append("\n".join(line.text for line in lines))
        else:
            parts.append(page.text)
    return "\n".join(parts)


def contains(text: str, secret: str) -> bool:
    """``secret``'s digits in order, allowing spaces or dashes between them."""
    digits = [digit for digit in secret if digit.isdigit()]
    return re.search(r"[\s-]?".join(digits), text) is not None


def score(fixtures: Sequence[Fixture]) -> SuiteResult:
    gateway = FakeGateway(Settings(_env_file=None, llm_fake=True), ledger=MemoryLedger())
    ok = clean = with_ssn = redacted = 0
    failures: list[str] = []
    for fixture in fixtures:
        labels = fixture.labels
        prepared = prepare_document(fixture.data, labels["content_type"])
        if labels["ssn"] is not None:
            with_ssn += 1
            if prepared.redaction_count > 0:
                redacted += 1
            else:
                failures.append(f"{labels['id']}: an SSN is printed but nothing was redacted")
        if prepared.model_pages:
            stub = gateway.extract_pay_stub(EVAL_USER, prepared.model_pages)
            pay_stub_proposal(stub, prepared.pages, prepared.withheld_pages)
            ok += 1
        else:
            failures.append(f"{labels['id']}: no readable page")
        sent = model_input_text(prepared.model_pages)
        leaked = [
            name
            for name in ("ssn", "account_number")
            if labels[name] is not None and contains(sent, labels[name])
        ]
        if leaked:
            failures.append(f"{labels['id']}: the model input holds the {' and '.join(leaked)}")
        else:
            clean += 1
    count = len(fixtures)
    return SuiteResult(
        metrics={
            "pipeline_ok": ok / count if count else 1.0,
            "redaction_recall": redacted / with_ssn if with_ssn else 1.0,
            "ssn_free": clean / count if count else 1.0,
        },
        cases=count,
        failures=failures,
    )


def run(budget: Budget) -> SuiteResult:
    return score(load_fixtures())


SUITE = Suite(name="extraction-smoke", llm=False, run=run)
