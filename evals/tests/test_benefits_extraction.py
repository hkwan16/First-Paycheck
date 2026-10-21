"""The benefits summary generator and the benefits-extraction suite (spec 013
rules 16-17)."""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterator, Sequence
from decimal import Decimal
from typing import Any

import pytest

from evals.gen import make_benefits as gen
from evals.suites import SUITES, benefits_extraction
from evals.suites.base import Budget, SuiteUnavailable
from ingest.pipeline import prepare_document
from llm.gateway import ModelPage
from llm.schemas import BenefitsSummaryExtraction

FIXTURES = gen.load_fixtures()


def _field(value: Any) -> dict[str, Any]:
    return {"value": value, "confidence": 0.95, "source_text": None}


class LabelReader:
    """Answers each summary from its labels, with optional mistakes."""

    def __init__(
        self,
        labels: Sequence[dict[str, Any]],
        *,
        wrong_deductible: bool = False,
        drop_last_plan: bool = False,
        wrong_vesting: bool = False,
        cumulative_bands: bool = False,
    ) -> None:
        self._labels: Iterator[dict[str, Any]] = iter(labels)
        self._wrong_deductible = wrong_deductible
        self._drop_last_plan = drop_last_plan
        self._wrong_vesting = wrong_vesting
        self._cumulative_bands = cumulative_bands
        self.pages: list[Sequence[ModelPage]] = []

    def extract_benefits(
        self, user_id: uuid.UUID, pages: Sequence[ModelPage], *, job_id: uuid.UUID | None = None
    ) -> BenefitsSummaryExtraction:
        self.pages.append(pages)
        labels = next(self._labels)
        plans = [dict(plan) for plan in labels["plans"]]
        if self._drop_last_plan:
            plans = plans[:-1]
        if self._wrong_deductible and plans:
            plans[0]["deductible_cents"] += 100
        bands = gen.bands_of(labels["match_tiers"])
        if self._cumulative_bands:
            # The mistake the prompt warns against: reporting the running total.
            bands = [
                (sum((band for band, _ in bands[: i + 1]), Decimal(0)), share)
                for i, (_, share) in enumerate(bands)
            ]
        vesting = labels["vesting_years"]
        if self._wrong_vesting:
            vesting = 7
        return BenefitsSummaryExtraction.model_validate(
            {
                "plans": [{key: _field(value) for key, value in plan.items()} for plan in plans],
                "match_tiers": [
                    {"band_pct": _field(float(band)), "employer_pct": _field(float(share))}
                    for band, share in bands
                ],
                "vesting_years": _field(vesting),
                "notes": None,
            }
        )


def labels() -> list[dict[str, Any]]:
    return [fixture.labels for fixture in FIXTURES]


def test_registered_as_an_llm_suite() -> None:
    assert SUITES["benefits-extraction"].llm is True


def test_committed_fixtures_regenerate_identically() -> None:
    summaries = gen.generate()
    committed = sorted(gen.DEFAULT_DIR.glob("*.json"))
    assert [path.stem for path in committed] == [summary.id for summary in summaries]
    for summary, path in zip(summaries, committed, strict=True):
        stale = f"{path.stem} is stale: run `uv run python -m evals.gen.make_benefits`"
        assert path.read_text() == gen.labels_json(summary), stale
        assert (gen.DEFAULT_DIR / summary.filename).read_bytes() == gen.render(summary), stale


def test_generation_is_deterministic_and_seed_dependent() -> None:
    assert gen.generate() == gen.generate()
    assert gen.generate(seed=1) != gen.generate()


def test_the_summaries_cover_the_variations() -> None:
    summaries = gen.generate()
    assert len(summaries) == 5
    assert {summary.scenario.layout for summary in summaries} == {"table", "prose"}
    assert {len(summary.plans) for summary in summaries} == {1, 2, 3}
    assert {plan.kind for summary in summaries for plan in summary.plans} == {"hdhp", "ppo", "hmo"}
    tier_counts = {len(summary.scenario.bands) for summary in summaries}
    assert tier_counts == {0, 1, 2}
    assert {summary.scenario.vesting_years for summary in summaries} >= {None, 0}
    assert any(summary.deadline is None for summary in summaries)
    assert sum(summary.ssn is not None for summary in summaries) == 1


def test_plans_are_valid_calculator_options() -> None:
    for summary in gen.generate():
        for plan in summary.plans:
            assert plan.deductible_cents <= plan.oop_max_cents
            if plan.kind == "hdhp":
                assert plan.deductible_cents >= 170_000
                assert plan.employer_hsa_cents
            else:
                assert plan.employer_hsa_cents is None


def test_the_text_prints_what_the_labels_say() -> None:
    for summary in gen.generate():
        text = "\n".join(gen.render_lines(summary))
        for plan in summary.plans:
            assert plan.name in text
            assert gen.premium(plan.premium_per_period_cents) in text
            assert gen.dollars(plan.deductible_cents) in text
            assert gen.dollars(plan.oop_max_cents) in text
        if summary.ssn is not None:
            assert re.fullmatch(r"9\d{2}-\d{2}-\d{4}", summary.ssn)
            assert summary.ssn in text
        if summary.account_number is not None:
            assert summary.account_number in text


def test_tier_labels_are_cumulative() -> None:
    first = gen.generate()[0]
    assert first.match_tiers() == [
        {"employee_pct_upto": "3.00", "employer_pct": "100.00"},
        {"employee_pct_upto": "5.00", "employer_pct": "50.00"},
    ]


def test_a_perfect_reader_scores_full_marks() -> None:
    result = benefits_extraction.score(FIXTURES, LabelReader(labels()))
    assert result.failures == []
    assert result.metrics == {
        "plan_field_accuracy": 1.0,
        "retirement_accuracy": 1.0,
        "document_accuracy": 1.0,
    }
    assert result.cases == 5


def test_one_wrong_plan_field_per_summary() -> None:
    result = benefits_extraction.score(FIXTURES, LabelReader(labels(), wrong_deductible=True))
    fields = sum(len(label["plans"]) for label in labels()) * 8
    assert result.metrics["plan_field_accuracy"] == pytest.approx(1 - 5 / fields)
    assert result.metrics["retirement_accuracy"] == 1.0
    assert result.metrics["document_accuracy"] == 0.0
    first = labels()[0]["plans"][0]["deductible_cents"]
    assert result.failures[0] == (
        f"summary-01 plan 0 deductible_cents: expected {first}, got {first + 100}"
    )


def test_a_missing_plan_counts_all_its_fields() -> None:
    result = benefits_extraction.score(FIXTURES, LabelReader(labels(), drop_last_plan=True))
    fields = sum(len(label["plans"]) for label in labels()) * 8
    assert result.metrics["plan_field_accuracy"] == pytest.approx(1 - 5 * 8 / fields)


def test_cumulative_bands_from_the_model_are_wrong_tiers() -> None:
    result = benefits_extraction.score(FIXTURES, LabelReader(labels(), cumulative_bands=True))
    # Only the two-tier summaries change: a running total of 3 then 5 becomes 3 then 8.
    assert result.metrics["retirement_accuracy"] == pytest.approx(3 / 5)
    assert result.metrics["plan_field_accuracy"] == 1.0


def test_wrong_vesting_fails_the_retirement_part() -> None:
    result = benefits_extraction.score(FIXTURES, LabelReader(labels(), wrong_vesting=True))
    assert result.metrics["retirement_accuracy"] == 0.0
    assert result.metrics["document_accuracy"] == 0.0


def test_the_reader_sees_only_redacted_text() -> None:
    reader = LabelReader(labels())
    benefits_extraction.score(FIXTURES, reader)
    secrets = 0
    for fixture, pages in zip(FIXTURES, reader.pages, strict=True):
        sent = " ".join(getattr(page, "text", "") for page in pages)
        for secret in (fixture.labels["ssn"], fixture.labels["account_number"]):
            if secret is not None:
                secrets += 1
                assert secret not in sent
    assert secrets == 2


def test_every_summary_is_read_from_its_text_layer() -> None:
    for fixture in FIXTURES:
        prepared = prepare_document(fixture.data, fixture.labels["content_type"])
        assert prepared.withheld_pages == []
        text = "\n".join(line for page in prepared.pages for line in page.lines)
        assert fixture.labels["plans"][0]["name"] in text


def test_benefits_extraction_needs_an_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    no_key = benefits_extraction.Settings(_env_file=None, anthropic_api_key=None)
    monkeypatch.setattr(benefits_extraction, "_settings", lambda: no_key)
    with pytest.raises(SuiteUnavailable, match="ANTHROPIC_API_KEY"):
        benefits_extraction.run(Budget(100))
