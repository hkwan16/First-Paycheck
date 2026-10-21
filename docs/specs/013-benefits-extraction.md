# 013: Benefits extraction: health plans, the 401(k) match and vesting

Status: Implemented, M6. The live Sonnet path (`llm_live`) and the `benefits-extraction` eval suite are written but have not been run against the Anthropic API, because no key was available when they were built; the suite's baseline holds the targets below until the first live run replaces it.

## Goal

Read a benefits summary the user uploads (document type `benefits`) into a proposal with every medical plan option, the employer's 401(k) match formula and the vesting schedule, each value with the model's confidence, so the review screen can show it beside the redacted source lines. What the user confirms becomes `benefits_plans` rows (the health plan calculator's options, spec 012) and `profiles.match_tiers` and `profiles.vesting_years` (the 401(k) calculator's formula, spec 006). The redacted text is chunked into `benefits_chunks` for the explanations (spec 008 rule 6, spec 012 rule 16). This extends spec 005, whose flow, redaction, retry and confirm rules all still hold; the rules below are what M6 adds or changes. Code: `api/llm/schemas.py` (`BenefitsSummaryExtraction`), `api/llm/prompts/extract_benefits/v2.md`, `api/ingest/proposal.py`, `api/calc/k401.py:tiers_from_bands`, `api/app/routers/docs.py`, `api/app/routers/benefits.py`, migration `0008_goals_and_birth_year` (`benefits_plans.position`), `evals/gen/make_benefits.py`, `evals/suites/benefits_extraction.py`.

## Inputs

| Input | Type | Valid range |
|---|---|---|
| Model pages | `TextPage` or `ImagePage` | Redacted per spec 004, as spec 005 |
| `POST /docs/{id}/confirm` | `{"benefits": BenefitsValues}` | Rules 9-13 |
| `GET /benefits-plans` | none | |

## Outputs

- `BenefitsSummaryExtraction` (model output, a proposal only).
- `documents.proposal` for a benefits document: `{kind: "benefits", plans, match_tiers, vesting_years, source_lines, withheld_pages, notes}`; `GET /docs/{id}` returns it while the document is `proposed` or `manual_entry_required`. A pay stub's proposal has `kind: "pay_stub"`.
- On confirm: `benefits_plans` rows, the profile's `match_tiers` and `vesting_years` when the body carries a `retirement` part, `benefits_chunks`, and spec 005's document changes. The response adds `profile_updated` (bool).
- `GET /benefits-plans`: the user's confirmed plans as `BenefitsPlanOut` (`id`, `document_id`, `name`, `kind`, `premium_per_period_cents`, `deductible_cents`, `oop_max_cents`, `coinsurance_pct`, `employer_hsa_cents`, `enrollment_deadline`, `created_at`).

## Rules

### Schema and prompt

1. `BenefitsSummaryExtraction` is `{plans, match_tiers, vesting_years, notes}`. `plans` is spec 005 rule 4's `PlanExtraction` list, unchanged.
2. `match_tiers` is a list of `MatchTierExtraction`, in the order the summary states them: `employer_pct` (the share of the employee's contribution the employer adds, 0 to 100: "100% of" is 100, "dollar for dollar" is 100, "50 cents on the dollar" is 50) and `band_pct` (the width of the tier in percent of pay, as printed: "the first 3%" is 3, "the next 2%" is 2, "up to 6%" with no earlier tier is 6). Each is an `ExtractedField` with its own confidence and source line. An empty list means the summary describes no match.
3. `vesting_years` is an `ExtractedField[int]` from 0 to 10: the years of service after which the match is fully vested ("immediately" is 0, "a 3-year cliff" is 3, "20% a year over 5 years" is 5). Null when the summary does not say.
4. The model never adds, converts or accumulates: it reports each tier's band as printed. The cumulative bounds the 401(k) calculator uses are code's (rule 6).
5. Prompt `extract_benefits/v2` (purpose `extract`, effort `low`, schema `BenefitsSummaryExtraction`) adds the match and vesting instructions to v1's plan instructions. `Gateway.extract_benefits` uses v2. `extract_benefits/v1` and its schema `BenefitsExtraction` stay in the repository unchanged because `llm_calls.prompt_version` may name it; nothing calls it.
6. `FakeGateway` answers from `api/tests/fixtures/llm/extract_benefits.json`, which now carries two plans, the tiers 100% of the first 3% and 50% of the next 2%, and a 3-year vesting schedule.

### The proposal (`ingest/proposal.py`)

7. Every proposal carries `kind`, `pay_stub` or `benefits`. A proposal stored before M6 has none; `Proposal.stored(data, document_type)` fills it from the document's type when it is read.
8. A benefits proposal has, besides spec 005 rule 19's `plans`:
   - `match_tiers`: one `TierProposal` per extracted tier, each with two fields of kind `percent` and role `info`. `employer_pct` is the tier's share with the model's confidence. `employee_pct_upto` is computed by `calc/k401.py:cumulative_bounds` (which `tiers_from_bands` also uses): the sum of this band and every band before it, so 3 then 2 become bounds 3 and 5. Its confidence is the lowest band confidence that went into it, and for every tier after the first its note is `Cumulative: <band>% added to the tiers before it`. When any band up to a tier is null, that tier's bound is null with the note `Not found on the document`, and so is every later one.
   - `vesting_years`: a field of kind `number` and role `info`, or the note `Not found on the document` when null.
   - A manual-entry benefits proposal has no plans, no tiers and an empty `vesting_years` field.
9. Percent values are two-place strings (`"5.00"`), as spec 005.

### Confirm

10. `BenefitsValues` is `{plans, retirement}`. `plans` is 0 to 20 `PlanValues`; `retirement` is null or `{match_tiers, vesting_years}` with `match_tiers` validated exactly as `PUT /profile` validates them (up to 5, both percentages in (0, 100], `employee_pct_upto` strictly ascending; spec 005 rule 25) and `vesting_years` 0 to 10 or null. A body with no plans and no `retirement` is 422.
11. `PlanValues` adds one check to spec 005's: `employer_hsa_cents` must be 0 unless `kind = hdhp`, the same rule the health plan calculator applies (spec 012 rule 12), so a confirmed plan is always a valid calculator option.
12. In the confirm transaction, besides spec 005 rule 22: the plans are inserted with `position` = their index in the body; when `retirement` is set, the profile is upserted with only `match_tiers` and `vesting_years` changed (a missing profile is created with defaults for the rest). `profile_updated` reports it.
13. Chunks are cut from the proposal's redacted source lines exactly as spec 005 rule 22 says; a benefits document confirmed from manual entry with no readable text writes no chunks.

### Reads

14. `GET /benefits-plans` returns every confirmed plan of the user, the most recently confirmed summary first, in the summary's order within a document: `ORDER BY coalesce(documents.confirmed_at, benefits_plans.created_at) DESC, document_id, position, id`. `confirmed_at` is the request clock, so two summaries confirmed in one database transaction (as the tests do) still order; `created_at` is `now()`, the transaction's start, which would tie.
15. `benefits_plans.position` (`smallint NOT NULL DEFAULT 0`, `CHECK (position >= 0)`, unique per `document_id` where it is not null) is added by migration `0008_goals_and_birth_year`, which numbers existing rows of each document by `created_at, id`.

### Evals

16. `evals/gen/make_benefits.py` writes 5 synthetic benefits summaries (`evals/fixtures/benefits/summary-0N.pdf`, text PDFs written by hand with no font dependency, so their bytes are reproducible) and labels beside each (`summary-0N.json`) from a fixed seed. They vary the layout (a plan table and a prose summary), the number of plans (1 to 3), the match wording (tiered, single-tier, dollar for dollar, none) and the vesting wording (immediate, cliff, graded, absent), and one prints a synthetic member SSN (900 area) and account number to exercise redaction. A test fails when the committed files differ from a fresh generation. No real plan document is used.
17. `benefits-extraction` (LLM, gated like `extraction`: `SuiteUnavailable` without `ANTHROPIC_API_KEY`, cost charged before each result is read) runs each summary through `prepare_document`, the real gateway and `benefits_proposal`. Metrics: `plan_field_accuracy`, the share of labeled plan fields (the seven of `PlanValues` except `enrollment_deadline`, plus the deadline, per labeled plan, matched in order) whose proposed value equals the label, a missing plan counting all its fields wrong and a null `employer_hsa_cents` equal to 0 (confirm stores 0); `retirement_accuracy`, the share of summaries whose computed tier list (bounds and shares) and `vesting_years` both equal the labels; `document_accuracy`, the share with every plan field and the retirement part right. Baseline targets until the first live run: 0.90, 0.80, 0.60.

## Hand-worked examples

### Cumulative tiers (`api/tests/unit/calc/test_k401_bands.py`)

| # | Test | Bands (band@share) | Tiers (upto@share) |
|---|---|---|---|
| 1 | `test_first_three_then_next_two` | 3@100, 2@50 | 3@100, 5@50 |
| 2 | `test_single_band` | 6@50 | 6@50 |
| 3 | `test_fractional_bands` | 1.5@100, 2.25@50 | 1.50@100, 3.75@50 |
| 4 | `test_no_bands` | none | none |

Example 3: `1.5 + 2.25 = 3.75`, exact in `Decimal`; the result is two-place percentages.

### The proposal (`api/tests/unit/ingest/test_proposal.py`)

`test_benefits_proposal_computes_cumulative_tiers`: the fake fixture's tiers (band 3 at confidence 0.9 with share 100, band 2 at confidence 0.8 with share 50) give `employee_pct_upto` values `"3.00"` (confidence 0.9, no note) and `"5.00"` (confidence 0.8, note `Cumulative: 2.00% added to the tiers before it`), shares `"100.00"` and `"50.00"`, and `vesting_years` 3.

`test_benefits_proposal_with_a_missing_band`: bands 3 then null give bounds `"3.00"` then null with the note `Not found on the document`.

### Confirm (`api/tests/integration/test_benefits.py`)

| # | Test | Body | Expected |
|---|---|---|---|
| 1 | `test_confirm_writes_plans_profile_and_chunks` | Two plans and `retirement` 3@100, 5@50, vesting 3 | 200, `profile_updated`; `GET /profile` has the tiers and vesting 3, other profile fields unchanged; `GET /benefits-plans` lists Bronze HSA then Gold PPO |
| 2 | `test_confirm_without_retirement_leaves_the_profile` | Plans only | `profile_updated` false; the profile's tiers unchanged |
| 3 | `test_retirement_only_summary` | No plans, `retirement` 6@50 | 200; no `benefits_plans` rows; tiers saved |
| 4 | `test_bad_confirm_is_422[empty_body]` | No plans, no retirement | 422 |
| 5 | `test_bad_confirm_is_422[employer_hsa_on_a_ppo]` | A PPO with `employer_hsa_cents` 50,000 | 422; nothing saved |
| 6 | `test_bad_confirm_is_422[tiers_must_ascend]` | `retirement` 5@100, 3@50 | 422; nothing saved |
| 7 | `test_newest_document_first` | Confirm two summaries | the second's plans first, each in body order |

`api/tests/integration/test_migrations.py::test_0008_numbers_existing_plans_in_list_order`: two plans of one document created on 2026-10-02 ("Second") and 2026-10-01 ("First") and one typed by hand get positions 1, 0 and 0.

## Edge cases

- A summary with only dental and vision plans: `plans` is empty; the user may confirm the retirement part alone.
- Tiers stated as one combined rate ("up to 4% of pay at 50%"): one band of 4 at 50.
- A match stated in dollars ("$1,000 a year") cannot be a percentage tier: the prompt asks for no tier and a note; the user types the formula.
- A summary that describes a match but not vesting: `vesting_years` null; confirm with null leaves the profile's vesting null.
- Confirming a second summary adds its plans beside the first summary's; nothing is deleted. The health plan screen chooses which plans to compare.

## Out of scope

- Dental, vision, life and disability plans.
- Coverage tiers other than employee-only.
- Editing or deleting a confirmed plan (a new summary or a hand-entered plan in a later milestone).
- Graded vesting percentages per year; only the years to full vesting are stored (spec 001, `profiles.vesting_years`).
