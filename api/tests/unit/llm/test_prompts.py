"""Prompt files: YAML front matter, a known schema and a body (spec 003 rule 20)."""

from __future__ import annotations

from pathlib import Path
from typing import get_args

import pytest
from pydantic import BaseModel

from db.enums import LlmPurpose
from llm import schemas
from llm.gateway import CATEGORIZE_PROMPT, EXPLAIN_PROMPT, JUDGE_RATE_CLAIM_PROMPT
from llm.prompts import PROMPTS_DIR, Prompt, PromptError, all_prompts, load_prompt, parse_prompt

VALID = """---
version: demo/v1
model: categorize
effort: low
max_tokens: 1000
schema: CategoryBatch
---
You label merchants.
"""


def test_every_prompt_file_loads() -> None:
    files = sorted(PROMPTS_DIR.glob("*/v*.md"))
    assert files, "no prompt files found"
    prompts = all_prompts()
    assert len(prompts) == len(files)
    for prompt in prompts:
        assert prompt.schema is getattr(schemas, prompt.schema.__name__)
        assert prompt.system.strip()


def test_version_matches_the_file_path() -> None:
    for path in PROMPTS_DIR.glob("*/v*.md"):
        prompt = parse_prompt(path.read_text(), source=path)
        assert prompt.version == f"{path.parent.name}/{path.stem}"


@pytest.mark.parametrize("version", ["v1", "v2", "v3"])
def test_categorize_prompts(version: str) -> None:
    prompt = load_prompt("categorize", version)
    assert prompt.version == f"categorize/{version}"
    assert prompt.purpose is LlmPurpose.CATEGORIZE
    assert prompt.effort == "low"
    assert prompt.schema is schemas.CategoryBatch
    # The prompt names every category the schema accepts.
    for category in schemas.CATEGORIES:
        assert f"`{category}`" in prompt.system


@pytest.mark.parametrize("version", ["v2", "v3"])
def test_categorize_explains_the_direction(version: str) -> None:
    """Spec 003 rule 9: the model is told what the direction means and that
    money in at a merchant is usually a refund unless it reads as pay."""
    system = load_prompt("categorize", version).system
    assert "`direction`" in system
    assert '`"in"`' in system
    assert '`"out"`' in system
    assert "usually a refund" in system
    assert "pay, payroll, deposit or transfer" in system


def test_categorize_v3_calls_a_nonprofit_membership_a_donation() -> None:
    """Spec 003 rule 9a (issue #146): v2 listed memberships under subscriptions,
    so the model labeled a public radio station's member dues a subscription.
    v3 defines such a membership as a donation, for every nonprofit, and names
    no merchant."""
    v2 = load_prompt("categorize", "v2").system
    v3 = load_prompt("categorize", "v3").system
    assert "news, memberships." in v2
    subscriptions = next(line for line in v3.splitlines() if line.startswith("- `subscriptions`"))
    assert "membership" not in subscriptions
    donations = next(line for line in v3.splitlines() if line.startswith("- `gifts_donations`"))
    assert "memberships or pledges to public radio and TV stations and other nonprofits" in (
        donations
    )
    assert "even when it recurs every month" in v3
    assert "kqed" not in v3.lower()


def definition(system: str, category: str) -> str:
    return next(line for line in system.splitlines() if line.startswith(f"- `{category}`"))


def test_categorize_v3_definitions_agree_with_the_seed_rules() -> None:
    """Spec 003 rule 9b: a merchant the model labels gets the category a seed
    rule gives a merchant of the same kind (costco and sams club shopping, a
    credit card payment transfer, turbotax taxes)."""
    system = load_prompt("categorize", "v3").system
    assert "warehouse clubs" in definition(system, "shopping")
    assert "warehouse" not in definition(system, "groceries")
    assert "credit card payments" in definition(system, "transfer")
    assert "A credit card payment is `transfer`" in definition(system, "debt_payment")
    assert "tax preparation" in definition(system, "taxes")
    assert "tax refunds" in definition(system, "income")


def test_the_gateway_uses_categorize_v3() -> None:
    assert CATEGORIZE_PROMPT == ("categorize", "v3")


@pytest.mark.parametrize(
    ("name", "schema", "nested"),
    [
        ("extract_pay_stub", schemas.PayStubExtraction, schemas.LineItem),
        ("extract_benefits", schemas.BenefitsExtraction, schemas.PlanExtraction),
    ],
)
def test_extraction_prompts_v1(name: str, schema: type[BaseModel], nested: type[BaseModel]) -> None:
    prompt = load_prompt(name, "v1")
    assert prompt.version == f"{name}/v1"
    assert prompt.purpose is LlmPurpose.EXTRACT
    assert prompt.effort == "low"
    assert prompt.schema is schema
    # The prompt explains every field the schema asks for, and the redaction marker.
    for field in [*schema.model_fields, *nested.model_fields]:
        assert f"`{field}`" in prompt.system, field
    assert "[REDACTED]" in prompt.system
    assert "YYYY-MM-DD" in prompt.system


def test_extract_benefits_v2() -> None:
    """Spec 013 rule 5: v2 adds the match and vesting to v1's plans."""
    prompt = load_prompt("extract_benefits", "v2")
    assert prompt.version == "extract_benefits/v2"
    assert prompt.purpose is LlmPurpose.EXTRACT
    assert prompt.effort == "low"
    assert prompt.schema is schemas.BenefitsSummaryExtraction
    for model in (
        schemas.BenefitsSummaryExtraction,
        schemas.PlanExtraction,
        schemas.MatchTierExtraction,
    ):
        for field in model.model_fields:
            assert f"`{field}`" in prompt.system, field
    assert "[REDACTED]" in prompt.system
    assert "YYYY-MM-DD" in prompt.system


def test_pay_stub_prompt_names_every_line_kind_and_field() -> None:
    prompt = load_prompt("extract_pay_stub", "v1")
    for kind in get_args(schemas.LineItemKind):
        assert f"`{kind}`" in prompt.system
    for frequency in get_args(schemas.PayFrequencyValue):
        assert f"`{frequency}`" in prompt.system


@pytest.mark.parametrize("version", ["v1", "v2"])
def test_explain(version: str) -> None:
    prompt = load_prompt("explain", version)
    assert prompt.version == f"explain/{version}"
    assert prompt.purpose is LlmPurpose.EXPLAIN
    assert prompt.effort == "medium"
    assert prompt.schema is schemas.ExplanationDraft
    # The prompt explains every field it writes and every part of the context it reads.
    for field in schemas.ExplanationDraft.model_fields:
        assert f"`{field}`" in prompt.system, field
    for field in schemas.ExplainContext.model_fields:
        assert f"`context.{field}`" in prompt.system, field
    assert "`feedback`" in prompt.system
    # No em dash anywhere in what the model reads.
    assert chr(0x2014) not in prompt.system


def test_explain_v2_keeps_the_chosen_rate_apart_from_the_stub() -> None:
    """Spec 008 rule 8 (issue 132): v1 told the model to describe "their current
    contribution" with only the chosen rate in the facts; v2 names both facts,
    says the chosen rate "would" or "will" happen, and is the version the gateway
    sends."""
    v1 = load_prompt("explain", "v1").system
    v2 = load_prompt("explain", "v2").system
    assert "at their current contribution" in v1
    assert "current contribution" not in v2
    for label in (
        "Contribution rate you chose",
        "401(k) contribution rate your latest pay stub shows",
    ):
        assert f"`{label}`" in v2, label
    # Plain guidance, not a description of a check: nothing rejects a draft
    # for its wording (spec 008 rule 8).
    assert '"would" or "will"' in v2
    assert "rejects" not in v2
    # The number habits behind most first-try failures: a tier's width and a
    # passage's percentages.
    assert '"the next 2%"' in v2
    assert '"100% vested"' in v2
    assert EXPLAIN_PROMPT == ("explain", "v2")


def test_judge_rate_claim() -> None:
    """Spec 008 rule 24a: the explain eval's judge runs on the explain model, explains
    every field it reads and writes, and is the version the gateway sends."""
    prompt = load_prompt("judge_rate_claim", "v1")
    assert JUDGE_RATE_CLAIM_PROMPT == ("judge_rate_claim", "v1")
    assert prompt.version == "judge_rate_claim/v1"
    assert prompt.purpose is LlmPurpose.EXPLAIN
    assert prompt.schema is schemas.RateClaimVerdict
    for field in schemas.RateClaimVerdict.model_fields:
        assert f"`{field}`" in prompt.system, field
    for field in schemas.RateClaimRequest.model_fields:
        assert f"`{field}`" in prompt.system, field
    for field in schemas.RateClaimDraft.model_fields:
        assert f"`draft.{field}`" in prompt.system, field
    # The cases the regular expressions could not tell apart (spec 008 rule 24): a
    # condition, a rate as the subject, and the full-match rate read against both rates.
    assert '"if you stay at ..."' in prompt.system
    assert '"The 6% you picked already gets the whole match"' in prompt.system
    assert "`pay_stub_rate` equals `full_match_rate`" in prompt.system
    assert chr(0x2014) not in prompt.system


def test_parse_valid_prompt() -> None:
    prompt = parse_prompt(VALID, source=Path("demo/v1.md"))
    assert prompt == Prompt(
        version="demo/v1",
        purpose=LlmPurpose.CATEGORIZE,
        effort="low",
        max_tokens=1000,
        schema=schemas.CategoryBatch,
        system="You label merchants.",
    )


@pytest.mark.parametrize(
    ("text", "problem"),
    [
        ("You label merchants.\n", "front matter"),
        (VALID.replace("schema: CategoryBatch\n", ""), "schema"),
        (VALID.replace("CategoryBatch", "NoSuchSchema"), "NoSuchSchema"),
        (VALID.replace("model: categorize", "model: claude-haiku-5-5"), "model"),
        (VALID.replace("effort: low", "effort: extreme"), "effort"),
        (VALID.replace("max_tokens: 1000", "max_tokens: 0"), "max_tokens"),
        (VALID.replace("max_tokens: 1000", "max_tokens: lots"), "max_tokens"),
        (VALID.replace("version: demo/v1", "version: v1"), "version"),
        (VALID.replace("You label merchants.\n", "   \n"), "body"),
        (VALID.replace("effort: low\n", "effort: low\ntemperature: 0\n"), "temperature"),
        ("---\n[not, a, mapping]\n---\nbody\n", "mapping"),
    ],
)
def test_invalid_prompts_are_rejected(text: str, problem: str) -> None:
    with pytest.raises(PromptError, match=problem):
        parse_prompt(text, source=Path("demo/v1.md"))


def test_missing_prompt_is_an_error() -> None:
    with pytest.raises(PromptError, match="categorize/v99"):
        load_prompt("categorize", "v99")
