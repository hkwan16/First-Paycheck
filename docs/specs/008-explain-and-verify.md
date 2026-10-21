# 008: Explain, verify, citations and retrieval

Status: Implemented, M3.

## Goal

Explain a saved decision in plain words from the calculator's own numbers, the curated IRS passages for that calculator and the user's benefits text, and show the explanation only after plain code has checked that every number in it is one the calculator produced or the user confirmed and every citation is a curated passage. A draft that fails gets one retry with the failure attached; a second failure shows the plain calculator result, flagged as a fallback. Code: `api/retrieval/` (citations, benefits search, the explain context), `api/verify/` (number extraction, checks, the draft-verify-retry-fallback flow and the fallback text), `api/llm/prompts/explain/v1.md`, `ExplanationDraft` in `api/llm/schemas.py`, `Gateway.explain`, routes `POST /explain` and `GET /decisions/{id}/explanation`, the seed `api/db/seed/irs_citations/k401.yaml`, and the eval suites `explain` and `explain-smoke`.

## Inputs

- `POST /explain`: `decision_id` (uuid) and `force` (bool, default false).
- `GET /decisions/{id}/explanation`: the decision id.
- The decision's `inputs` and `result` (spec 007 rule 3), the `irs_citations` rows for its calculator and `tax_year`, and up to three of the user's `benefits_chunks` that match the calculator's search query.

## Outputs

`ExplanationOut`: `id`, `decision_id`, `concept`, `text`, `numbers` (`NumberClaim`: `value`, `label`), `what_ifs` (strings), `citations` (`CitationOut`: `key`, `title`, `url`, `passage`, `source`), `verified`, `fallback`, `attempt`, `retries`, `prompt_version`, `verification` (`numbers_checked`, `numbers_unmatched`, `citations_checked`, `citations_unknown`, `has_citation`) and `created_at`. `POST /explain` and `GET /decisions/{id}/explanation` both return it.

## Rules

### Citations and retrieval

1. **Seed.** `api/db/seed/irs_citations/<calculator prefix>.yaml` lists entries with `key`, `calculator`, `tax_year`, `title`, `url` (https, irs.gov), `source` (the IRS document name), `passage`, `verified` and `verified_on`. A passage is quoted exactly from the live page, under 80 words, with `...` marking any omitted words; each part between ellipses appears verbatim in the page text. An entry whose page could not be fetched says `verified: false` and is not loaded.
2. **Keys for 2026** (`k401.yaml`): `k401.deferral_limit` (Notice 2025-67, 402(g)), `k401.catch_up` (IR-2025-111), `k401.compensation_limit` (Notice 2025-67, 401(a)(17)), `k401.employer_match` (IRS, matching contributions), `k401.pretax_deferral` (IRS 401(k) Resource Guide), `k401.vesting` (IRS, Retirement topics: Vesting), `k401.federal_brackets` (IR-2025-103). They cover every key spec 006 rule 11 can emit.
3. **Table.** `irs_citations` has no `user_id`: `calculator calculator_kind`, `key`, `title`, `url` (`CHECK (url LIKE 'https://%')`), `passage`, `source`, `tax_year smallint`, `verified_on date`, `created_at`, `updated_at`; `UNIQUE (calculator, key, tax_year)`. RLS is enabled and forced, `authenticated` holds `SELECT` with a `USING (true)` policy, and nothing else may write; the seed loader writes on the privileged connection.
4. **Loader.** `make seed` upserts every verified entry on `(calculator, key, tax_year)` and deletes rows the files no longer list, in one transaction; running it twice changes nothing.
5. **`retrieval/citations.py:for_calculator(session, calculator, tax_year)`** returns that calculator's citations for the year, ordered by key.
6. **`retrieval/benefits_search.py:search(session, user_id, query, k)`** ranks the user's `benefits_chunks` against the stored `search` vector with one `plainto_tsquery('english', word)` per whitespace-separated word of `query`, joined with `||` (OR), so user words are never parsed as tsquery syntax and a chunk needs only one word to match (a single `plainto_tsquery` of the whole query would AND every word, and real plan text rarely holds all of them in one chunk), ordered by `ts_rank` descending then `(document_id, chunk_index)`, and returns at most `k` (`text`, `rank`, `document_id`, `chunk_index`). It runs under RLS and also filters on `user_id`. The explain context uses `k = 3` and the query `401(k) retirement match vesting` for `k401_match`.

### The context and the prompt

7. **Facts.** `retrieval/context.py` turns a decision into `ExplainContext`: the calculator, `tax_year`, a list of facts (`label`, `value`) with every money value written as dollars with cents (`$2,400.00`) and every percentage as `5%` or `4.5%`, the allowed citations (`key`, `title`, `passage`) and the benefits passages. Only redacted text is ever in `benefits_chunks` (spec 004), so nothing unredacted reaches the model.
8. **Prompt** `llm/prompts/explain/v1.md` (model `explain`, schema `ExplanationDraft`) tells the model to use only the facts' numbers, written exactly as given or as whole dollars, to cite only the given keys and at least one, and to avoid dates, ages and any other figure. A released prompt file is never edited.
9. **Draft schema.** `ExplanationDraft`: `concept` (one sentence naming the idea), `text` (two to five short paragraphs), `numbers` (list of `NumberClaim`: `value` as written in the text and a `label`), `what_ifs` (up to three short strings) and `citation_keys`.
10. **Gateway.** `Gateway.explain(user_id, context, feedback=None)` sends the context as JSON (and, on a retry, the verifier's feedback) and returns an `ExplanationDraft`, with the budget, refusal branch, validation and ledger every gateway call has. `FakeGateway` writes a draft from the facts and cites the first allowed key, so it verifies.

### Verification (no LLM)

11. **`verify/numbers.py:extract_numbers(text)`** finds every number in `text` and returns `NumberToken(raw, value, kind)` with `kind` in `money` (a `$`, with an optional leading `-`), `percent` (followed by `%` or the word `percent`) or `plain`. It reads `$1,234.56`, `1234`, `6%`, `6.0%`, `-$12`. It skips digits that belong to a word or a code reference: statute numbers followed by a parenthesis (`401(k)`, `402(g)`, `414(v)`) and their numbered subsections (`401(a)(17)`), form names (`W-4`, `W-2`, `1040`, preceded by "Form"), Form W-4 step numbers (`Step 2`, `Steps 3`, added for spec 014) and digits glued to letters (`3rd`, `k401`, `4(c)`).
12. **Allowed numbers** (`verify/allowed.py:AllowedNumbers.from_decision(inputs, result)`): every value in the decision's inputs and result, walked recursively. Keys with a `_cents` part (`salary_cents`, `employer_match_cents_full`) give money values, allowed both exactly (`$2,400.00`, `$2,400`) and as whole dollars rounded half up (`$46` for 4,615 cents). Keys with a `_pct` or `_rate` part (`contribution_pct`, `employee_pct_upto`, `marginal_rate_used`) give percentages. `tax_year` is an allowed year; `pay_periods_per_year` is an allowed count; any other integer input (`age`) is an allowed plain number. Booleans and strings are skipped.
13. **Matching.** A money token matches when its magnitude equals an allowed money value exactly, or, written without cents, equals an allowed whole-dollar value. A percent token matches an allowed percentage by value (`6%`, `6.0%` and `6.00%` are the same). A plain token matches an allowed year, count or plain number, or a money value in dollars (`2,400` for 240,000 cents). The sign of a money token is ignored: `-$12` reads as a drop of $12.
14. **`verify/verify.py:verify_explanation(draft, allowed_numbers, allowed_citation_keys)`** extracts numbers from `concept`, `text`, every `what_ifs` entry and every `NumberClaim` value, and returns `Verification`: `numbers_checked`, `numbers_unmatched` (the raw tokens that matched nothing), `citations_checked`, `citations_unknown` (keys not allowed), `has_citation` and `passed` (no unmatched number, no unknown key, at least one citation). `feedback()` describes each failure in one line for the retry.

### The flow (`verify/flow.py`) and storage

15. **Draft, verify, retry once, fall back.** Attempt 1 drafts and verifies. If it fails, attempt 2 drafts again with the feedback appended and verifies. If that fails too, a fallback row follows. A gateway error (`LLMError`: budget, refusal, schema, unavailable) ends the run at once with the fallback; nothing is retried after a refusal or a spent budget.
16. **Every attempt is a row.** Each drafted attempt writes one `explanations` row (`attempt` 1 or 2, `verified` from the check, `fallback = false`); the fallback writes one more row (`attempt` = the next number, `verified = false`, `fallback = true`). `retries` on every row is the number of retries made in the run so far (0 or 1). `prompt_version` is the explain prompt's (`explain/v1`) on drafted rows and `fallback/v1` (`verify/fallback.py:FALLBACK_VERSION`) on the fallback row, whose text no prompt wrote.
17. **Fallback text** (`verify/fallback.py`) is the plain calculator result written by code, for `k401_match`: the full-match percentage, the match at the current and full-match percentage, the dollars missed, the per-paycheck cost before and after federal tax with the marginal rate, the deferral limit and, when they apply, the capped and compensation-capped notes. Its citations are the result's `citation_keys` that the seed holds, so a fallback is cited too.
18. **Table `explanations`.** `decision_id` (composite same-user foreign key, `ON DELETE CASCADE`) or `finding_id` (no foreign key until `0005`), `CHECK (num_nonnulls(decision_id, finding_id) = 1)`; `attempt smallint CHECK (attempt BETWEEN 1 AND 3)`; `retries smallint CHECK (retries IN (0, 1))`; `concept`, `text` (`NOT NULL`); `numbers`, `what_ifs`, `citations` (`jsonb` arrays, default `[]`; `citations` holds keys); `prompt_version`; `verified`, `fallback` with `CHECK (NOT (verified AND fallback))`; `verification jsonb` (the counts of rule 14, an object); `created_at timestamptz DEFAULT clock_timestamp()`, so rows written in one transaction keep their order. Append-only: the owner policy with `SELECT` and `INSERT` grants. Index `(decision_id, created_at)`.
19. **Latest.** The latest explanation of a decision is its row with the greatest `(created_at, attempt)`.
20. **Idempotent `POST /explain`.** Without `force`, when the decision already has a verified explanation, the latest verified row is returned and nothing is generated. Otherwise (none yet, only fallbacks, or `force = true`) a new run starts.
21. **No transaction across the model call.** The route reads the decision and its context in one short user session, calls the gateway with no transaction open, and writes the run's rows in a second user session, so a 30-second model call never holds a pooled connection.
22. **Status codes.** `POST /explain` is 200 with the final row; another user's decision is 404; an LLM that is not configured (no key and `LLM_FAKE` off) is 503 `llm_unavailable`, raised only when a model call is needed: a 404 or a stored verified explanation is answered without a model. `GET /decisions/{id}/explanation` is 404 `not_found` when the decision has no explanation. A user may start 30 runs per clock hour (UTC), counted with the upload limiter (`app/ratelimit.py`, bucket `explain.run`, spec 004 rule 5) in the first session, after the stored-explanation check and the model check: a 404, a stored verified explanation and a 503 do not count, and the 31st run in a window is 429 `rate_limited` with `Retry-After` (seconds to the next window) and writes nothing.
23. **Citations in the response** resolve the row's keys against `irs_citations` for the decision's calculator and `tax_year`, in the row's order.

## Evals

24. **`explain`** (LLM, `make eval-llm`): 10 synthetic decisions (`evals/fixtures/explain/decisions.json`, each a `k401_match` input whose result the suite computes with `calc/k401.py`) through the real flow with `LLMGateway`, an in-memory ledger charged against `--max-cost-cents`, and the seed citations read from the YAML. Metrics: `first_try_verified` (share verified on attempt 1), `no_fallback` (1 minus the fallback rate) and `cited` (share whose final row has at least one citation). Baseline at the targets: `no_fallback >= 0.95` (technical spec: fallback rate at most 5%), `cited = 1.0`, `first_try_verified >= 0.8`. Raises `SuiteUnavailable` without `ANTHROPIC_API_KEY`.
25. **`explain-smoke`** (free, `make eval`): the same flow with `ScriptedGateway` (a `FakeGateway` that answers from a script, in `llm/gateway.py`) over three scenarios: verified on the first try, a failing draft then a verified one, and two failing drafts. Metric `flow_correct`: the share of scenarios whose rows (count, `verified`, `fallback`, `attempt`, `retries`) match the expected run. Baseline 1.0.

## Hand-worked examples

### Number extraction (`api/tests/unit/verify/test_numbers.py`)

| Text | Tokens (value, kind) |
|---|---|
| `You miss $1,234.56 a year.` | (1234.56, money) |
| `That is 1234 dollars.` | (1234, plain) |
| `Contribute 6% or 6.0%.` | (6, percent), (6.0, percent) |
| `Take-home drops -$12.` | (-12, money) |
| `Your 401(k) and W-4 under 402(g)` | none |
| `In 2026, 26 paychecks of $46.15` | (2026, plain), (26, plain), (46.15, money) |
| `5 percent of pay` | (5, percent) |

### Verification (`api/tests/unit/verify/test_verify.py`), on spec 006 example 1

Allowed: money 60,000.00, 1,800.00, 2,400.00, 600.00, 3,000.00, 46.15, 40.62, 24,500.00 (and their whole dollars 60,000, 1,800, 2,400, 600, 3,000, 46, 41, 24,500); percents 3, 5, 12, 100, 50; year 2026; count 26; plain 30.

| Draft text | Passed | Unmatched |
|---|---|---|
| `Moving from 3% to 5% adds $600.00 of match for $46.15 a paycheck.` | yes | none |
| `That is about $41 after tax at 12%.` | yes | none |
| `You would get $650 more.` | no | `$650` |
| `Raise it to 7%.` | no | `7%` |
| citation keys `["k401.made_up"]` | no | unknown `k401.made_up` |
| citation keys `[]` | no | no citation |

### The flow (`api/tests/integration/test_explain.py`)

| Test | Gateway | Rows | Final |
|---|---|---|---|
| `test_pass_first_try` | one good draft | 1: attempt 1 verified | verified, retries 0 |
| `test_fail_then_pass` | bad, good | 2: attempt 1 unverified, attempt 2 verified | verified, retries 1 |
| `test_fail_twice_falls_back` | bad, bad | 3: two unverified, attempt 3 fallback | fallback with the calculator result, retries 1 |
| `test_gateway_error_falls_back` | refusal | 1: attempt 1 fallback | fallback, retries 0 |
| `test_idempotent_post` | good | second POST adds no row | same id |
| `test_force_regenerates` | good, good | `force=true` adds a row | new id |
| `test_get_explanation_404_when_none` | none | 0 | 404 |
| `test_rate_limit_is_thirty_runs_per_clock_hour` | 31 good | 30 forced runs; the 31st adds no row | 429 with `Retry-After: 30` at 14:59:30 |

## Edge cases

- A decision whose `tax_year` has no seeded citations: the allowed list is empty, every draft fails `has_citation`, and the fallback carries no citations. The seed ships 2026 only; a new tax year needs its passages before its decisions can be explained with citations.
- A number the user typed (salary) is allowed because inputs are allowed; a number the model derived (a monthly figure) is not, by design.
- A model that echoes a citation passage's figures (for example "$8,000" catch-up for a 30-year-old) fails verification unless the figure is also a result or input value; the prompt tells it not to.

## Out of scope

- Explaining check-in findings (`finding_id`, M8).
- Caching across users or reusing an explanation after the decision's version changes: each version is explained on its own.
