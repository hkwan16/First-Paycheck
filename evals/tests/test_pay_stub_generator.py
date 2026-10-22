"""The seeded synthetic pay stub generator and its committed fixtures."""

from __future__ import annotations

import json
import re

from evals.gen import make_pay_stubs as gen

MAGIC = {
    "application/pdf": b"%PDF-",
    "image/png": b"\x89PNG\r\n\x1a\n",
    "image/jpeg": b"\xff\xd8\xff",
}
MONEY = [
    "gross_cents",
    "federal_withholding_cents",
    "social_security_cents",
    "medicare_cents",
    "state_tax_cents",
    "retirement_contribution_cents",
    "medical_premium_cents",
    "other_deductions_cents",
    "net_cents",
]


def test_committed_labels_regenerate_identically() -> None:
    stubs = gen.generate()
    committed = sorted(gen.DEFAULT_DIR.glob("*.json"))
    assert [path.stem for path in committed] == [stub.id for stub in stubs]
    for stub, path in zip(stubs, committed, strict=True):
        assert json.loads(path.read_text()) == stub.labels(), (
            f"{path.name} is stale: run `uv run python -m evals.gen.make_pay_stubs`"
        )


def test_generation_is_deterministic_and_seed_dependent() -> None:
    assert gen.generate() == gen.generate()
    assert gen.generate(seed=1) != gen.generate()


OUTPUTS = {"text_pdf", "png", "noisy_png", "noisy_jpeg", "scanned_pdf"}


def test_thirty_stubs_across_layouts_and_formats() -> None:
    stubs = gen.generate()
    assert len(stubs) == 30
    assert {stub.layout for stub in stubs} == {"ledger", "summary", "advice"}
    # Every layout appears in every output format.
    for layout in ("ledger", "summary", "advice"):
        assert {stub.output for stub in stubs if stub.layout == layout} == OUTPUTS, layout
    noisy = [stub for stub in stubs if stub.output in ("noisy_png", "noisy_jpeg", "scanned_pdf")]
    assert len(noisy) >= 12
    assert sum(stub.ssn is not None for stub in stubs) >= 15
    assert len({stub.frequency for stub in stubs}) == 4
    assert any(stub.ssn_masked for stub in stubs)
    assert any(stub.account_masked for stub in stubs)
    assert any(stub.account is not None and not stub.account_masked for stub in stubs)


def test_every_stub_balances_to_the_cent() -> None:
    for stub in gen.generate():
        fields = stub.labels()["fields"]
        deductions = sum(fields[key] or 0 for key in MONEY[1:-1])
        assert fields["gross_cents"] - deductions == fields["net_cents"], stub.id
        assert fields["other_deductions_cents"] == sum(
            line.cents for line in (*stub.taxes, *stub.deductions) if line.field is None
        )


def test_synthetic_identifiers_are_never_real() -> None:
    for stub in gen.generate():
        if stub.ssn is not None:
            # Area numbers 900-999 are never issued.
            assert re.fullmatch(r"9\d{2}-\d{2}-\d{4}", stub.ssn)
        if stub.account is not None:
            assert re.fullmatch(r"\d{10,12}", stub.account)


def test_html_prints_what_the_labels_say() -> None:
    for stub in gen.generate():
        html = gen.render_html(stub)
        labels = stub.labels()
        if labels["ssn"] is not None:
            assert labels["ssn"] in html
        if labels["account_number"] is not None:
            assert labels["account_number"] in html
        if stub.ssn_masked:
            assert f"XXX-XX-{stub.ssn_last4}" in html
        assert gen.dollars(labels["fields"]["net_cents"]) in html


def test_committed_files_are_what_the_labels_name() -> None:
    for stub in gen.generate():
        labels = stub.labels()
        data = (gen.DEFAULT_DIR / labels["file"]).read_bytes()
        assert data.startswith(MAGIC[labels["content_type"]]), labels["file"]
        assert len(data) < 2_000_000
