# 005: Pay stub and benefits extraction, review and confirm

Status: Implemented, M2. The `extraction` eval suite first ran live on October 29 (issue #123): on `claude-sonnet-5-5` every run scored `field_accuracy` and `document_accuracy` 1.0 over the 30 stubs for 55 to 56 cents, and the baseline holds those measurements. Rule 24a (`annual_salary_cents` on the stub output) added in M10. Rules 9, 10 and 23 name replaced documents since spec 004 rules 24-31. Rule 24b (`retirement_contribution_pct`, the 401(k) rate the stub shows) added for issue 132.

## Goal

Turn the redacted pages of spec 004 into a proposal the user reviews field by field, then store exactly what the user confirmed. The extraction runs as the `ingest.extract` job in the worker (spec amendment 1): Claude Sonnet 5.5 reads redacted text and redacted page images and returns typed JSON; plain code turns it into reviewable fields with roles, links each field to the redacted line it came from, and enforces gross minus deductions equals net on confirm (spec amendment 17). Code: `api/llm/schemas.py`, `api/llm/prompts/extract_pay_stub/v1.md`, `api/llm/prompts/extract_benefits/v1.md`, `api/llm/gateway.py` (`extract_pay_stub`, `extract_benefits`), `api/jobs/handlers/ingest_extract.py`, `api/ingest/proposal.py`, `api/calc/pay_stub.py`, routes in `api/app/routers/docs.py`, `api/app/routers/pay_stubs.py`, `api/app/routers/profile.py`, eval suites `evals/suites/extraction.py` and `evals/suites/extraction_smoke.py`.

## Inputs

| Input | Type | Valid range |
|---|---|---|
| `POST /docs/{id}/extract` | path id | A document of the user's with a blob, status not `confirmed`, type `pay_stub` or `benefits` |
| Model pages | `TextPage(number, text)` or `ImagePage(number, png)` | Redacted per spec 004; at least one |
| `POST /docs/{id}/confirm` | `{"pay_stub": PayStubValues}` or `{"benefits": {"plans": [PlanValues]}}` | Rules 16-21 |
| `PUT /profile` | `ProfileIn` | Rule 25 |

## Outputs

- `PayStubExtraction` and `BenefitsExtraction` (model output, never stored as confirmed data).
- `documents.proposal` (jsonb): `{fields, line_items, plans, source_lines, withheld_pages, notes}`, returned by `GET /docs/{id}` when the status is `proposed` or `manual_entry_required` (the redacted lines to type from), and null otherwise.
- `jobs.result` for `ingest.extract`: `{document_id, status, page_count, redaction_count, withheld_pages}`. Ids and counts only, never extracted text (spec 001 rule 28).
- On confirm (200): one `pay_stubs` row, or `benefits_plans` rows plus `benefits_chunks`; the blob deleted; `documents.status = confirmed`, `confirmed_at` and `deleted_at` set. The response is `{document, pay_stub, plans}`: the document as `GET /docs` lists it and what was stored.
- `GET /pay-stubs`: confirmed stubs, newest pay date first, each with `annual_salary_cents` (integer cents or null, rule 24a) and `retirement_contribution_pct` (a two-place percentage string or null, rule 24b). `GET /profile`, `PUT /profile`: the profile.

## Rules

### Schema (`llm/schemas.py`)

1. `ExtractedField[T]` is `{value: T | null, confidence: 0..1, source_text: string | null}`. `value` is null when the document does not show it; `source_text` is the printed line the value was read from, copied as it appears, `[REDACTED]` included.
2. `PayStubExtraction` has one `ExtractedField` per `pay_stubs` column the stub prints: `employer_name` (text), `pay_date`, `period_start`, `period_end` (ISO dates), `pay_frequency` (`weekly`, `biweekly`, `semimonthly`, `monthly`), and the this-period amounts in integer cents `gross_cents`, `federal_withholding_cents`, `social_security_cents`, `medicare_cents`, `state_tax_cents`, `retirement_contribution_cents`, `medical_premium_cents`, `net_cents`. It also has `line_items` and `notes`.
3. `other_deductions_cents` is not a model output: it is a sum, and the model never does money math. Each `LineItem` is `{label, amount_cents, kind, field}` with `kind` one of `earning`, `tax`, `pre_tax_deduction`, `post_tax_deduction`, `net`, `info` and `field` naming the column above that the line is already counted in, or null. Code computes `other_deductions_cents` as the sum of `amount_cents` over line items whose kind is `tax`, `pre_tax_deduction` or `post_tax_deduction` and whose `field` is null.
4. `BenefitsExtraction` is `{plans: [PlanExtraction], notes}`; `PlanExtraction` has `ExtractedField`s `name`, `kind` (`hdhp`, `ppo`, `hmo`), `premium_per_period_cents`, `deductible_cents`, `oop_max_cents`, `coinsurance_pct` (the member's share, 0 to 100), `employer_hsa_cents`, `enrollment_deadline`.
5. Prompts `extract_pay_stub/v1` and `extract_benefits/v1` use purpose `extract` (model `LLM_MODEL_EXTRACT`, Sonnet 5.5), effort `low`, and their schema.

### Gateway (`llm/gateway.py`)

6. `extract_pay_stub(user_id, pages, job_id=)` and `extract_benefits(...)` send one user message whose content is every image page as a base64 PNG `image` block, in page order, followed by one `text` block that lists which page numbers the images are and then each text page as `Page N (text layer):` and its redacted text. Everything else (budget first, cached system prompt, `output_config` with effort and the JSON schema, no temperature, no prefill, refusal checked before the output is read, schema validation, the `llm_calls` row) is spec 003 rules 21-27.
7. A call with no pages raises `ValueError` before anything is sent or recorded.
8. `FakeGateway` answers extraction from `api/tests/fixtures/llm/extract_pay_stub.json` and `extract_benefits.json`, through the same budget, validation and ledger code.

### The `ingest.extract` job

9. `POST /docs/{id}/extract` locks the document row, and returns the current job's id when the document is `extracting` and that job is still `queued` or `running` (idempotent while running). Otherwise it queues a new `ingest.extract` job with payload `{document_id}`, sets `status = extracting`, `extract_job_id` and clears `status_reason`, and returns `{job_id}` (202). A replaced document is 409 `document_replaced` (spec 004 rule 28), a confirmed or deleted one 409 `document_confirmed` or `document_deleted`; an `offer_letter` is 422 `extraction_unsupported`. From `manual_entry_required` it queues only when the reading was unavailable (`no_model`, `budget`, `extraction_failed`), which `can_read_again` says; after `refused` or `no_readable_page` it is 409 `document_already_read` (spec 004 rules 32-35).
10. The job reads the blob in one short user session, then runs `prepare_document` (spec 004) and the gateway call with no transaction open, then writes the outcome in one user session, only while the document is still `extracting` under this job and has not been replaced (spec 004 rule 28).
11. **Proposed.** With at least one usable page and a valid model answer, the document becomes `proposed` with `proposal`, `redaction_count` and `page_count`.
12. **Manual entry.** No usable page (`no_readable_page`), a refusal (`refused`), a spent daily budget (`budget`), or no model (`no_model`: the worker has no gateway, which only happens outside production (spec 003 rule 12a), or the call raised `LLMMisconfigured` because the API rejected the key or the model id, spec 003 rule 24) makes the document `manual_entry_required` without retrying, keeping `redaction_count` and `page_count` and a proposal with the redacted source lines and no fields filled.
13. A schema error or any other API error (rate limit, 5xx, timeout, connection failure, other 4xx) raises so the queue retries (spec 002 rule 34); on the fifth and last attempt the job instead marks the document `manual_entry_required` (`extraction_failed`) and succeeds.
14. An unreadable file (spec 004 rule 9) marks the document `failed` (`unreadable_file`) without retrying. A document with no blob (deleted meanwhile) ends the job with `{"status": "skipped"}`.
15. The gateway never receives page text or images that were not redacted: text pages carry `redact_text` output and image pages the `redact_image` output; withheld pages are not sent.

### The proposal (`ingest/proposal.py`)

16. Pay stub fields, in this order, with `kind` and `role`: `employer_name` (text, info), `pay_date`, `period_start`, `period_end` (date, info), `pay_frequency` (text, info), `gross_cents` (money, gross), `federal_withholding_cents`, `social_security_cents`, `medicare_cents`, `state_tax_cents`, `retirement_contribution_cents`, `medical_premium_cents`, `other_deductions_cents` (money, deduction), `net_cents` (money, net). Each carries `key, label, value, confidence, note, kind, role`. Money values are integer cents, dates ISO strings.
17. `other_deductions_cents` comes from rule 3 with `confidence` null and the note `Sum of: <labels>` (or `No other deductions listed`). Any other field whose value is null gets the note `Not found on the document`. The model's self-reported confidence is shown as is; the UI marks below 0.9 for review (spec amendment 12).
18. `source_lines` are the redacted lines of every page that was read, in order, each `{page, text, field_key, redacted}`. `redacted` is true when the line contains `[REDACTED]`. A field's `source_text` links to the first unclaimed line that contains it after both are lowercased and whitespace-collapsed; failing that, for money fields, the first unclaimed line containing the value printed as dollars (`1,996.04`). A line links to at most one field.
19. Benefits proposals have one `plans` entry per extracted plan, each with its fields (all role `info`), and the same `source_lines`.

### Confirm

20. The body is validated by `PayStubValues` (or `PlanValues`), the value-typed twin of the extraction schema: dates are dates, money is strict integer cents (`gross_cents > 0`, the rest `>= 0`), `period_start <= period_end`, `pay_frequency` an enum or null, `employer_name` at most 200 characters. A unit test keeps its keys equal to the extraction's keys plus `other_deductions_cents`.
21. **Arithmetic gate.** `calc/pay_stub.py:balance` computes `deductions = federal + social security + medicare + state + retirement + medical premium + other deductions` and `difference = gross - deductions - net`. A non-zero difference is 422 `pay_stub_unbalanced` with `details = {gross_cents, deductions_cents, net_cents, expected_net_cents, difference_cents}`. The `pay_stubs` check constraint is the database backstop.
22. Confirm is allowed from `proposed` and `manual_entry_required` (manual entry is a confirm with every field typed). The values stored are the ones in the body, never the proposal's. In one transaction: insert `pay_stubs` (or `benefits_plans`, plus `benefits_chunks` from `chunk_words` over the proposal's redacted source lines joined by newlines), delete the blob, set `status = confirmed`, `confirmed_at = deleted_at = now()`, clear `status_reason`.
23. Confirming a replaced document is 409 (`document_replaced`, spec 004 rule 28); confirming twice is 409 (`document_confirmed`); a document whose file was deleted is 409 (`document_deleted`); one not yet read (`uploaded`, `extracting`, `failed`) is 409 (`document_not_ready`). A body for the wrong type (`benefits` for a pay stub) is 422 (`wrong_document_type`), and a body with neither or both keys is 422.

### Reads and profile

24. `GET /pay-stubs` returns the user's stubs ordered by `pay_date DESC, created_at DESC`, every column including the generated `tax_year`.
24a. **Yearly salary the stub implies.** Every stub output (`PayStubOut`: `GET /pay-stubs` and the confirm response's `pay_stub`) carries `annual_salary_cents`: `gross_cents` times the pay periods a year for its `pay_frequency` (weekly 52, biweekly 26, semimonthly 24, monthly 12), from `calc/pay_stub.py:annual_salary_cents`. It is an integer product of integer cents, so no rounding is applied and it need not be a round figure. A stub with no `pay_frequency` gives null. It is computed on read, never stored, and it is not written to the profile: the client offers it as the starting salary in the plan details form, which the user saves with `PUT /profile` (the profile's own `salary_cents` wins when set). Gross on one stub can include overtime or a bonus, which is why it is a starting value the user can change, not a confirmed salary.
24b. **401(k) rate the stub shows.** Every stub output also carries `retirement_contribution_pct`: `retirement_contribution_cents` as a percentage of this paycheck's `gross_cents`, `retirement_contribution_cents * 100 / gross_cents` computed exactly and rounded half up once to two places, from `calc/pay_stub.py:retirement_contribution_pct`. It is a `Decimal` with exactly two places, sent as a JSON string (`"3.00"`), like every percentage the API returns (`calc/types.py:ResultPercent`). It is the same arithmetic as spec 015's `actual_pct`. A stub with no retirement line (stored as 0) shows nothing going to the 401(k), so its rate is `"0.00"`, not null. It is null only when it cannot be computed: a gross of zero or less, which confirm refuses (rule 20), so a stored stub has one in practice. It is computed on read, never stored, and never written to a decision: it is what the person contributes now, which the 401(k) card starts from (spec 006 rule 14) and the explanation states beside the rate the person chose (spec 008 rule 7a). Payroll can round a per-paycheck deferral to the cent, and a flat-dollar election is no whole percentage at all, so the rate need not be a round figure.
25. `GET /profile` returns the saved profile, or the defaults (nulls, empty lists, `dependents = 0`) when none is saved. `PUT /profile` replaces it: `salary_cents` strict int > 0 or null; `pay_frequency`, `filing_status`, `expected_healthcare_usage` enums or null; `other_jobs` a list of up to 5 `{annual_wages_cents > 0}`; `dependents` 0-20; `start_date` a date or null; `match_tiers` up to 5 tiers `{employee_pct_upto, employer_pct}` with both in (0, 100] and `employee_pct_upto` strictly ascending (spec 006); `vesting_years` 0-10 or null. Percentages are decimals with at most 2 places, sent and returned as JSON strings.

### Evals

26. `extraction` (LLM): for each of the 30 labeled synthetic stubs in `evals/fixtures/pay_stubs/` (10 since M2, 20 more in M10: three layouts, every layout in all five outputs, 15 of them noisy PNG or JPEG scans or scanned PDFs), run `prepare_document`, the real gateway with an in-memory ledger that charges the run's budget, and the proposal builder. `field_accuracy` is the share of labeled fields (13 per stub: `pay_frequency`, the three dates and the nine money fields including the computed `other_deductions_cents`; a column the stub does not print is labeled null) whose proposed value equals the label exactly; `document_accuracy` the share of stubs with every one of them right. Redaction runs before the model and does not depend on it, so this suite does not score it: rule 27's `extraction-smoke` gates it at zero tolerance, where an LLM suite would tolerate one case's worth. Targets, which a measurement has to clear before the baseline records it: field accuracy at least 0.95 on the 30-stub set (0.90 on the M2 set of 10), document accuracy 0.70. A run costs about 56 cents (Sonnet, one call per stub); the nightly workflow caps the whole run with `--max-cost-cents`. Without `ANTHROPIC_API_KEY` the suite is unavailable and the runner exits 2.
27. `extraction-smoke` (free): the same pipeline with `FakeGateway`; `pipeline_ok` is the share of stubs that produce a proposal, `redaction_recall` the share of stubs labeled with an SSN whose `redaction_count` is non-zero (target 1.0), and `ssn_free` the share of stubs whose model input contains no labeled SSN or unmasked account number, checked on text pages directly and on image pages by OCR'ing the redacted PNG again.

## Hand-worked examples

### Arithmetic gate (`tests/unit/calc/test_pay_stub.py`)

| # | Test | Gross | Fed | SS | Medicare | State | 401(k) | Medical | Other | Net | Difference |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `test_mockup_stub_balances` | 270,833 | 29,776 | 16,792 | 3,927 | 9,814 | 0 | 6,250 | 4,670 | 199,604 | 0 |
| 2 | `test_two_cents_off` | 270,833 | 29,776 | 16,792 | 3,927 | 9,814 | 0 | 6,250 | 4,670 | 199,606 | -2 |
| 3 | `test_no_deductions` | 100,000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100,000 | 0 |

Working for row 1 (the Confirm mockup's stub): deductions = 29,776 + 16,792 + 3,927 + 9,814 + 0 + 6,250 + 4,670 = 71,229 cents; 270,833 - 71,229 = 199,604 = net, so the difference is 0. `other_deductions_cents` 4,670 is CA SDI 3,250 plus dental and vision 1,420, two line items with no column of their own. Row 2: the expected net is still 199,604, so a net of 199,606 gives 199,604 - 199,606 = -2 and confirm answers 422 with `difference_cents = -2`.

### Yearly salary (`tests/unit/calc/test_pay_stub.py`, rule 24a)

| # | Test | Gross | Pay frequency | Periods | `annual_salary_cents` |
|---|---|---|---|---|---|
| 1 | `test_annual_salary_semimonthly_mockup_stub` | 270,833 | semimonthly | 24 | 6,499,992 |
| 2 | `test_annual_salary_every_frequency` | 250,000 | weekly, biweekly, semimonthly, monthly | 52, 26, 24, 12 | 13,000,000; 6,500,000; 6,000,000; 3,000,000 |
| 3 | `test_annual_salary_without_frequency` | 270,833 | null | none | null |

Working for row 1 (the Acme stub, $2,708.33 twice a month): 270,833 x 24 = 6,499,992 cents, $64,999.92. Not $65,000.00: the product is exact and nothing rounds it to the salary the stub was made from. Row 2: 250,000 x 52 = 13,000,000; x 26 = 6,500,000; x 24 = 6,000,000; x 12 = 3,000,000. The route test `tests/integration/test_pay_stubs.py::test_every_column_is_returned` reads row 1 back from `GET /pay-stubs`.

### 401(k) rate (`tests/unit/calc/test_pay_stub.py`, rule 24b)

| # | Test | Gross | 401(k) | Exact rate | `retirement_contribution_pct` |
|---|---|---|---|---|---|
| 1 | `test_contribution_rate_stub_01` | 365,385 | 10,962 | 3.000123... | 3.00 |
| 2 | `test_contribution_rate_rounds_half_up` | 320,000 | 10,000 | 3.125 | 3.13 |
| 3 | `test_contribution_rate_uneven` | 270,833 | 10,000 | 3.692312... | 3.69 |
| 4 | `test_contribution_rate_no_retirement_line` | 270,833 | 0 | 0 | 0.00 |
| 5 | `test_contribution_rate_zero_gross` | 0 | 0 | none | null |

Working for row 1 (the synthetic `evals/fixtures/pay_stubs/stub-01.pdf`, $109.62 of a $3,653.85 biweekly paycheck, the stub of issue 132): `10,962 * 100 / 365,385 = 1,096,200 / 365,385 = 3.000123...`, which rounds to 3.00. The stub's employer set 3%: `365,385 * 3% = 10,961.55`, which payroll rounded to 10,962 cents, so the rate read back is a hair over 3% and the two places hide it. Row 2: `1,000,000 / 320,000 = 3.125` exactly, a tie on the third place; half up gives 3.13 (banker's rounding would give 3.12). Row 3: `1,000,000 / 270,833 = 3.692312...`, which rounds down to 3.69: a $100.00 flat election on the Acme stub is no whole percentage. Row 4: nothing withheld for the 401(k) is a rate of 0.00. Row 5: a zero gross has no rate (null), and the function never divides by zero. The route test `tests/integration/test_pay_stubs.py::test_every_column_is_returned` reads a stub-01-shaped stub back from `GET /pay-stubs` with `"3.00"`.

### Other deductions (`tests/unit/ingest/test_proposal.py::test_other_deductions_sum_unassigned_lines`)

Line items: `FED W/H 29,776 tax field=federal_withholding_cents`, `CA SDI 3,250 tax field=null`, `DENTAL/VIS 1,420 pre_tax_deduction field=null`, `YTD GROSS 541,666 info field=null`. `other_deductions_cents = 3,250 + 1,420 = 4,670`; the federal line is already in its column and the info line is not a deduction. Note: `Sum of: CA SDI, DENTAL/VIS`.

## Edge cases

- A stub the model reads with gross missing: the proposal shows the field null with its note; the user must type it before confirm passes rule 20.
- Benefits text over 400 words becomes several chunks; under it, one; a benefits document with no readable text writes no chunks.
- `POST /docs/{id}/extract` on a `failed` (unreadable) document queues another attempt while the blob exists; after retention deletes the blob it is 409.
- A refused document is confirmed by hand: the model read it and declined, so reading again is 409 `document_already_read` (spec 004 rule 35). Before issue #163 it could be read again, though nothing on screen offered it.
- A key the API rejects (an unfunded account answers 401) sends the document to manual entry (`no_model`) on the job's first attempt, with one `api_error` row; once the key works, the user can read it again ("Read again", spec 004 rules 32-34).

## Out of scope

- Offer letter extraction (the type is accepted on upload; extraction and confirm return 422 until a later milestone defines its schema).
- Inferring pay frequency from the period dates, and updating the profile from a confirmed stub; the client prefills `PUT /profile` instead.
- `GET /benefits-plans` and using benefits chunks in explanations (M6).
- The Batches API for extraction.
