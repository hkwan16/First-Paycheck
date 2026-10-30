# 008: Explain, verify, citations and retrieval

Status: Implemented, M3. Rule 7a, `explain/v2`, `fallback/v2` and the `rate_framing` eval metric added for issue 132: the explanation tells the rate the person chose from the rate their pay stub shows. Rules 24a and 24b: `rate_framing` is scored by an LLM judge, calibrated by `judge_accuracy`.

## Goal

Explain a saved decision in plain words from the calculator's own numbers, the curated IRS passages for that calculator and the user's benefits text, and show the explanation only after plain code has checked that every number in it is one the calculator produced or the user confirmed and every citation is a curated passage. A draft that fails gets one retry with the failure attached; a second failure shows the plain calculator result, flagged as a fallback. Code: `api/retrieval/` (citations, benefits search, the explain context), `api/verify/` (number extraction, checks, the draft-verify-retry-fallback flow and the fallback text), `api/llm/prompts/explain/v2.md` (v1 is kept for the rows it wrote), `ExplanationDraft` in `api/llm/schemas.py`, `Gateway.explain`, `Gateway.judge_rate_claim` and `api/llm/prompts/judge_rate_claim/v1.md` (the explain eval's judge, rule 24a), routes `POST /explain` and `GET /decisions/{id}/explanation`, the seed `api/db/seed/irs_citations/k401.yaml`, and the eval suites `explain` and `explain-smoke`.

## Inputs

- `POST /explain`: `decision_id` (uuid) and `force` (bool, default false).
- `GET /decisions/{id}/explanation`: the decision id.
- The decision's `inputs` and `result` (spec 007 rule 3), the `irs_citations` rows for its calculator and `tax_year`, and up to three of the user's `benefits_chunks` that match the calculator's search query.
- The user's newest confirmed pay stub's `retirement_contribution_pct` (spec 005 rule 24b), or null when no stub is confirmed (rule 7a). It is read when the explanation runs and never stored on the decision.

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
7a. **The rate the pay stub shows (`k401_match`, issue 132).** A decision's `contribution_pct` is the rate the person chose; payroll keeps taking the old rate until they change their election with their employer, so it is not what they contribute now. `POST /explain` reads, in its first session, the newest confirmed pay stub (`pay_date DESC, created_at DESC`, as `GET /pay-stubs` lists them) and passes its `retirement_contribution_pct` (spec 005 rule 24b) on as `pay_stub_pct`, null without a stub; calculators other than `k401_match` ignore it. It goes into the explanation only, never into the decision: decisions are immutable (spec 007) and a stub confirmed after the save can show a different rate, so the same decision explained after a new stub may be explained differently, and each run's rows keep what was written then. In the context: the first fact is `Contribution rate you chose` (the decision's rate) and, when a stub rate is known, the second is `401(k) contribution rate your latest pay stub shows` (formatted like every percentage, `3%`); the facts about the match and the yearly contribution say "at the rate you chose". Which case holds is decided once, by `calc/pay_stub.py:stub_rate(chosen, pay_stub_pct)`, comparing the two rates by value (`3.00` equals `3`): `StubRate.CHOSEN` (the stub shows the chosen rate: it is in effect now), `StubRate.OTHER` (the stub shows another rate: that is what goes in now, and the chosen rate takes effect once the election is changed with the employer) or `StubRate.NONE` (no pay stub is confirmed: what goes in now is not known). The context's one note (no digits), the fallback's stub sentence and its full-match sentence (rule 17) and the eval's `rate_framing` (rule 24) are each looked up by that value. `retrieval/context.py:explain_setup` builds the context, the allowed numbers, the citation keys and the fallback (rule 17) from the same `pay_stub_pct`, for the route and the eval suites alike.
8. **Prompt** `llm/prompts/explain/v2.md` (model `explain`, schema `ExplanationDraft`) tells the model to use only the facts' numbers, written exactly as given or as whole dollars, to cite only the given keys and at least one, and to avoid dates, ages and any other figure. For a 401(k) decision it explains the rate the person chose, keeps it apart from the rate their pay stub shows (what goes in now), and describes the chosen rate with "would" or "will" unless a note says the stub shows it, never as something the person already contributes or gets. Nothing in code rejects a draft for its wording: the verifier checks numbers and citations (rule 14), and how often drafts frame the rate correctly is measured by the eval (rule 24, `rate_framing`). It describes a match formula only by the tiers the facts give, never by a tier's width ("50% of the next 2%"), and writes no percentage from the benefits passages that the facts do not hold (a vesting schedule, "100% vested"): the live eval's remaining number failures were those. `explain/v1` told the model to "say what the person gets at their current contribution" with only the chosen rate in the facts, so it called a chosen rate the current one ("You are already contributing 5%" for a stub at 3%); it stays on disk for the rows it wrote, and the gateway sends v2. A released prompt file is never edited.
9. **Draft schema.** `ExplanationDraft`: `concept` (one sentence naming the idea), `text` (two to five short paragraphs), `numbers` (list of `NumberClaim`: `value` as written in the text and a `label`), `what_ifs` (up to three short strings) and `citation_keys`.
10. **Gateway.** `Gateway.explain(user_id, context, feedback=None)` sends the context as JSON (and, on a retry, the verifier's feedback) and returns an `ExplanationDraft`, with the budget, refusal branch, validation and ledger every gateway call has. `FakeGateway` writes a draft from the facts and cites the first allowed key, so it verifies.

### Verification (no LLM)

11. **`verify/numbers.py:extract_numbers(text)`** finds every number in `text` and returns `NumberToken(raw, value, kind)` with `kind` in `money` (a `$`, with an optional leading `-`), `percent` (followed by `%` or the word `percent`) or `plain`. It reads `$1,234.56`, `1234`, `6%`, `6.0%`, `-$12`. It skips digits that belong to a word or a code reference: statute numbers followed by a parenthesis (`401(k)`, `402(g)`, `414(v)`) and their numbered subsections (`401(a)(17)`), form names (`W-4`, `W-2`, `1040`, preceded by "Form"), Form W-4 step numbers (`Step 2`, `Steps 3`, added for spec 014) and digits glued to letters (`3rd`, `k401`, `4(c)`).
12. **Allowed numbers** (`verify/allowed.py:AllowedNumbers.from_decision(inputs, result)`): every value in the decision's inputs and result, walked recursively. Keys with a `_cents` part (`salary_cents`, `employer_match_cents_full`) give money values, allowed both exactly (`$2,400.00`, `$2,400`) and as whole dollars rounded half up (`$46` for 4,615 cents). Keys with a `_pct` or `_rate` part (`contribution_pct`, `employee_pct_upto`, `marginal_rate_used`) give percentages. `tax_year` is an allowed year; `pay_periods_per_year` is an allowed count; any other integer input (`age`) is an allowed plain number. Booleans and strings are skipped. The pay stub's rate (rule 7a) is allowed too: `retrieval/context.py:pay_stub_numbers` gives `{"pay_stub_contribution_pct": "3.00"}` for a `k401_match` decision with a stub rate (nothing otherwise), which `from_decision` reads as a percentage like any `_pct` key.
13. **Matching.** A money token matches when its magnitude equals an allowed money value exactly, or, written without cents, equals an allowed whole-dollar value. A percent token matches an allowed percentage by value (`6%`, `6.0%` and `6.00%` are the same). A plain token matches an allowed year, count or plain number, or a money value in dollars (`2,400` for 240,000 cents). The sign of a money token is ignored: `-$12` reads as a drop of $12.
14. **`verify/verify.py:verify_explanation(draft, allowed_numbers, allowed_citation_keys)`** extracts numbers from `concept`, `text`, every `what_ifs` entry and every `NumberClaim` value, and returns `Verification`: `numbers_checked`, `numbers_unmatched` (the raw tokens that matched nothing), `citations_checked`, `citations_unknown` (keys not allowed), `has_citation` and `passed` (no unmatched number, no unknown key, at least one citation). `feedback()` describes each failure in one line for the retry.

### The flow (`verify/flow.py`) and storage

15. **Draft, verify, retry once, fall back.** Attempt 1 drafts and verifies. If it fails, attempt 2 drafts again with the feedback appended and verifies. If that fails too, a fallback row follows. A gateway error (`LLMError`: budget, refusal, schema, unavailable) ends the run at once with the fallback; nothing is retried after a refusal or a spent budget.
16. **Every attempt is a row.** Each drafted attempt writes one `explanations` row (`attempt` 1 or 2, `verified` from the check, `fallback = false`); the fallback writes one more row (`attempt` = the next number, `verified = false`, `fallback = true`). `retries` on every row is the number of retries made in the run so far (0 or 1). `prompt_version` is the explain prompt's (`explain/v2`) on drafted rows and `fallback/v2` (`verify/fallback.py:FALLBACK_VERSION`) on the fallback row, whose text no prompt wrote. `fallback/v1` wrote "You already earn the full match" at any chosen rate; v2 is rule 17's text.
17. **Fallback text** (`verify/fallback.py`) is the plain calculator result written by code, for `k401_match`: the rate chosen and, when the pay stub's rate is known, either that the stub shows the same rate or the stub's rate and that the chosen rate takes effect once the election is changed with the employer; "You already earn the full match" only when the stub shows the chosen rate; the full-match percentage, the match at the chosen and full-match percentage, the dollars missed, the per-paycheck cost before and after federal tax with the marginal rate, the deferral limit and, when they apply, the capped and compensation-capped notes. Its citations are the result's `citation_keys` that the seed holds, so a fallback is cited too.
18. **Table `explanations`.** `decision_id` (composite same-user foreign key, `ON DELETE CASCADE`) or `finding_id` (no foreign key until `0005`), `CHECK (num_nonnulls(decision_id, finding_id) = 1)`; `attempt smallint CHECK (attempt BETWEEN 1 AND 3)`; `retries smallint CHECK (retries IN (0, 1))`; `concept`, `text` (`NOT NULL`); `numbers`, `what_ifs`, `citations` (`jsonb` arrays, default `[]`; `citations` holds keys); `prompt_version`; `verified`, `fallback` with `CHECK (NOT (verified AND fallback))`; `verification jsonb` (the counts of rule 14, an object); `created_at timestamptz DEFAULT clock_timestamp()`, so rows written in one transaction keep their order. Append-only: the owner policy with `SELECT` and `INSERT` grants. Index `(decision_id, created_at)`.
19. **Latest.** The latest explanation of a decision is its row with the greatest `(created_at, attempt)`.
20. **Idempotent `POST /explain`.** Without `force`, when the decision already has a verified explanation, the latest verified row is returned and nothing is generated. Otherwise (none yet, only fallbacks, or `force = true`) a new run starts.
21. **No transaction across the model call.** The route reads the decision and its context in one short user session, calls the gateway with no transaction open, and writes the run's rows in a second user session, so a 30-second model call never holds a pooled connection.
22. **Status codes.** `POST /explain` is 200 with the final row; another user's decision is 404; an LLM that is not configured (no key and `LLM_FAKE` off, which production refuses at startup, spec 003 rule 12a) is 503 `llm_unavailable`, raised only when a model call is needed: a 404 or a stored verified explanation is answered without a model. `GET /decisions/{id}/explanation` is 404 `not_found` when the decision has no explanation. A user may start 30 runs per clock hour (UTC), counted with the upload limiter (`app/ratelimit.py`, bucket `explain.run`, spec 004 rule 5) in the first session, after the stored-explanation check and the model check: a 404, a stored verified explanation and a 503 do not count, and the 31st run in a window is 429 `rate_limited` with `Retry-After` (seconds to the next window) and writes nothing.
23. **Citations in the response** resolve the row's keys against `irs_citations` for the decision's calculator and `tax_year`, in the row's order.

## Evals

24. **`explain`** (LLM, `make eval-llm`): 29 synthetic decisions (`evals/fixtures/explain/decisions.json`, each a `k401_match` input whose result the suite computes with `calc/k401.py`, and the rate its pay stub shows, `pay_stub_contribution_pct`, or null for no stub; 10 since M3, 19 more for issue 132, with issue 132's stub-01 case and a stub rate other than the chosen rate in 14 of them, so that one flaky draft moves a metric by under 4 points rather than 10) through the real flow with `LLMGateway`, an in-memory ledger charged against `--max-cost-cents`, and the seed citations read from the YAML. Metrics: `first_try_verified` (share verified on attempt 1), `no_fallback` (1 minus the fallback rate), `cited` (share whose final row has at least one citation) and `rate_framing`: over the 18 decisions whose stub rate differs from the chosen rate or is null, the share whose final row (a draft or the fallback) does not claim the chosen rate is already in effect. `rate_framing` is scored by an LLM judge (rule 24a), called once per scored decision on its final row; a failure line names the decision and quotes the sentence the judge found. It measures drafts and never gates one: nothing in `POST /explain` calls the judge, and the verifier stays numbers and citations only (rule 14). `judge_accuracy` checks the judge itself: the share of the hand-labeled items in `evals/fixtures/explain/rate_claims.json` (rule 24b) on which its verdict matches the label, so a run shows whether a low `rate_framing` is the drafts or the judge misreading them. One case is one decision for the first three metrics (worth 1/29), one scored decision for `rate_framing` (1/18) and one labeled item for `judge_accuracy`. An earlier version scored `rate_framing` with two regular expressions (the person as the subject of "already", or the rate chosen called "already in effect"); they could not tell which rate a sentence was about, and flagged true sentences about the pay stub's rate ("If you stay at the 4% on your pay stub, you already get the full match") in live runs, so the judge replaced them. Baseline at the targets: `no_fallback >= 0.95` (technical spec: fallback rate at most 5%), `cited = 1.0`, `first_try_verified >= 0.8`; the recorded baseline is what the live runs measured (evals/CLAUDE.md, Rules), `rate_framing` and `judge_accuracy` included. Raises `SuiteUnavailable` without `ANTHROPIC_API_KEY`.
24a. **The rate-claim judge.** `Gateway.judge_rate_claim(user_id, request)` sends a `RateClaimRequest` as JSON with `llm/prompts/judge_rate_claim/v1.md` (schema `RateClaimVerdict`) and returns the verdict, with the budget, refusal branch, validation and ledger every gateway call has. The request holds `chosen_rate` (the decision's `contribution_pct`, formatted like a fact, `5%`), `pay_stub_rate` (the stub's rate, or null for no confirmed pay stub), `full_match_rate` (the result's `full_match_pct`, or null when the plan has no match) and `draft`, the final row's `concept`, `text` and `what_ifs` (`RateClaimDraft`); nothing else of the decision. The full-match rate is there because the commonest wording names it instead of a number ("you are already at the full-match rate" is about the pay stub when the stub shows that rate, and a claim when only the chosen rate is it). The verdict is `reason` (one or two sentences on which rate the present-tense sentences describe, written first so the model works it out before it answers, and for reading misses), `claims_chosen_rate_in_effect` and `sentence`, the first sentence that makes the claim copied from the draft, required exactly when the claim is made (a reply that breaks this is a schema error). The judge reports the claim, not its truth: a draft that says the chosen rate is in effect when the stub shows that rate is a claim too, and `rate_framing` only counts the claim on the 18 decisions where it is false. A present-tense statement is a claim when it describes the rate chosen as what goes in now, by naming it or by naming an outcome ("you already earn the full match") that only the rate chosen gives; it is not one when it is about the stub's rate ("If you stay at the 4% on your pay stub, you already get the full match"), when a rate is its subject and it says what that rate earns ("The 5% you chose already earns the full match"), or when it is framed as a choice, a condition or the future. The prompt's front matter names the `explain` purpose, so the judge runs on `LLM_MODEL_EXPLAIN` and its ledger rows have purpose `explain` and prompt version `judge_rate_claim/v1`: a purpose of its own would need a new `llm_purpose` label (a migration) and a new `LLM_MODEL_*` setting for a call only the eval makes. A model grading its own kind of output can share its blind spots; `judge_accuracy` over items written by hand, many from live drafts, is the check on that. `FakeGateway` answers "no claim" (`claims_chosen_rate_in_effect` false, `sentence` null), so the free suites and the unit tests need no key; `ScriptedGateway` answers from its script like any call. The judge's errors (`LLMError`) do not stop the run: the item or decision counts as missed, with a failure line naming the error.
24b. **Calibration items** (`evals/fixtures/explain/rate_claims.json`): each has an `id`, the two rates and the full-match rate as a decision would give them (`chosen_pct`, `pay_stub_pct` or null, `full_match_pct` or null), the draft's `text` (and optionally `concept` and `what_ifs`), the label `claims` and, when it is a sentence from a live run, the fixture `decision` it came from (whose rates it must carry, a test checks). Synthetic only, at least 12 that make no claim and 8 that do, covering a rate as the subject, the person as the subject, conditionals, the stub's rate as what goes in now, no stub, a stub equal to the chosen rate, no match, and a claim in the concept or a what-if. Every row of the rate-framing table below is an item with the same rates and label (a test checks).
25. **`explain-smoke`** (free, `make eval`): the same flow with `ScriptedGateway` (a `FakeGateway` that answers from a script, in `llm/gateway.py`) over six scenarios: verified on the first try, a failing draft then a verified one, and two failing drafts on a 401(k) decision; the same pass and fail-twice on a W-4 decision (spec 014 rule 19); and, on issue 132's decision (5% chosen, the stub at 3%), a first try that states the stub's rate and verifies. Metric `flow_correct`: the share of scenarios whose rows (count, `verified`, `fallback`, `attempt`, `retries`) match the expected run. Baseline 1.0.

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

### The rate the pay stub shows (rules 7a and 12), on spec 006 example 11

Issue 132's decision: the stub-01 salary (9,500,010 cents, biweekly), 100% up to 3% and 50% up to 5%, the person chose 5%; the newest stub shows 3.00 (spec 005 rule 24b, row 1). The context starts `Contribution rate you chose: 5%`, `401(k) contribution rate your latest pay stub shows: 3%`, `Contribution rate that earns the full match: 5%`, and its note says the stub shows another rate. `tests/unit/verify/test_fallback_and_context.py`:

| Pay stub rate | Draft text | Passed | Problem |
|---|---|---|---|
| 3.00 | `Your pay stub shows 3% going to your 401(k) now. At the 5% you chose, your employer adds $3,800.00 a year.` | yes | none |
| 3.69 | `Your latest pay stub shows 3.69%.` | yes | none (the stub's rate is allowed) |
| none | `Your latest pay stub shows 3.69%.` | no | `3.69%` |

The fallback for the first row starts "At the 5% you chose, you put in $4,750.01 a year and your employer adds $3,800.00. Your latest pay stub shows 3% going to your 401(k), so the rate you chose takes effect once you change your election with your employer. That rate earns the full match of $3,800.00 a year." and goes on to the limit; it does not claim the chosen rate is in effect, and verifies.

### The stub's case (rule 7a), `tests/unit/calc/test_pay_stub.py`

| Chosen | Pay stub rate | `stub_rate` |
|---|---|---|
| 5 | none | `none` |
| 5 | 5.00 | `chosen` |
| 0 | 0.00 | `chosen` |
| 4 | 3.99 | `other` |
| 5 | 3.00 | `other` |

### Rate framing (rules 24, 24a and 24b), `evals/fixtures/explain/rate_claims.json`

Each row is a calibration item: the rate chosen, the stub's rate (none for no confirmed stub), the full-match rate, the final text and the judge's expected `claims_chosen_rate_in_effect`. The rows marked "live" are sentences from final explanations of the decision named, which the regular expressions flagged (rule 24); each describes the pay stub's rate, which is in effect, or has a rate as its subject.

| Chosen | Stub | Full match | Final text | Claims |
|---|---|---|---|---|
| 5% | 3% | 5% | `You are already contributing 5%.` | yes |
| 5% | 3% | 5% | `You're already at 5%.` | yes |
| 5% | 3% | 5% | `You already earn the full match.` | yes |
| 5% | none | 5% | `You already earn the full match.` | yes |
| 5% | 3% | 5% | `Each paycheck, you already put 5% in.` | yes |
| 5% | 3% | 5% | `The 5% you chose is already in effect.` | yes |
| 5% | 3% | 5% | `Because you are already at the full-match rate, moving to it costs you an extra $0.00 per paycheck before tax and $0.00 after federal income tax.` | yes |
| 2% | 4% | 4% | `You are already missing out on part of your employer's match.` | yes |
| 3% | 3% | 5% | `You are already contributing 3%.` (the stub shows the chosen rate: a true claim, not scored) | yes |
| 5% | 3% | 5% | `The 5% you chose already earns the full match, so the match you miss is $0.00.` (live, `issue-132-stub-01-chose-full-match`) | no |
| 12% | none | 5% | `Moving to the full-match rate would not cost you more per paycheck, because the rate you chose already earns the full match.` (live, `catch-up-61`) | no |
| 4% | 3.69% | 4% | `Because the rate you chose already earns the full match, moving to the full-match rate would cost you an extra $0.00 per paycheck before tax and $0.00 after federal income tax.` (live, `uneven-stub-rate`) | no |
| 2% | 4% | 4% | `The 4% your pay stub shows already earns the full match.` (live, `lowered-below-match`) | no |
| 10% | 5% | 5% | `Going from 5% to the full-match rate costs you an extra $0.00 per paycheck before tax and $0.00 after federal income tax, because the rate already earning the full match is the one on your pay stub.` (live, `capped-from-lower`) | no |
| 2% | 4% | 4% | `If you stay at the 4% on your pay stub, you already get the full match.` (live, `lowered-below-match`) | no |
| 10% | 5% | 5% | `Because you are already at the full-match rate, moving to it costs you an extra $0.00 per paycheck before tax and $0.00 after federal income tax.` (live, `capped-from-lower`: the stub shows the full-match rate) | no |
| 8% | 6% | 6% | `You already earn the full match.` (the stub's rate earns it) | no |
| 5% | 3% | 5% | `Your pay stub shows 3% going to your 401(k) now. At the 5% you chose, your employer would add $3,800.00 a year.` | no |
| 5% | 3% | 5% | `You have already chosen the full-match rate.` | no |

The same sentence, "Because you are already at the full-match rate, ...", is a claim when only the rate chosen is the full-match rate and true when the stub shows it, which is why the judge is given the full-match rate. A run of the stub-differs and no-stub decisions where the judge finds the claim in two of 18 final rows scores `rate_framing` 16/18; a judge that reads 36 of the 37 items as labeled scores `judge_accuracy` 36/37.

### The flow (`api/tests/integration/test_explain.py`)

| Test | Gateway | Rows | Final |
|---|---|---|---|
| `test_pass_first_try` | one good draft | 1: attempt 1 verified | verified, retries 0 |
| `test_fail_then_pass` | bad, good | 2: attempt 1 unverified, attempt 2 verified | verified, retries 1 |
| `test_fail_twice_falls_back` | bad, bad | 3: two unverified, attempt 3 fallback | fallback with the calculator result, retries 1 |
| `test_context_has_the_pay_stub_rate` | the fake's draft | 1: attempt 1 verified | the model was sent the newest stub's 3% beside the chosen 5% |
| `test_gateway_error_falls_back` | refusal | 1: attempt 1 fallback | fallback, retries 0 |
| `test_idempotent_post` | good | second POST adds no row | same id |
| `test_force_regenerates` | good, good | `force=true` adds a row | new id |
| `test_get_explanation_404_when_none` | none | 0 | 404 |
| `test_rate_limit_is_thirty_runs_per_clock_hour` | 31 good | 30 forced runs; the 31st adds no row | 429 with `Retry-After: 30` at 14:59:30 |

## Edge cases

- A decision whose `tax_year` has no seeded citations: the allowed list is empty, every draft fails `has_citation`, and the fallback carries no citations. The seed ships 2026 only; a new tax year needs its passages before its decisions can be explained with citations.
- A number the user typed (salary) is allowed because inputs are allowed; a number the model derived (a monthly figure) is not, by design.
- No confirmed pay stub (rule 7a): the context has no stub fact, the note says what goes in now is not known, and `rate_framing` counts the decision. The 401(k) card needs a confirmed stub before it can save, so in practice this is an eval or a test.
- A stub with no retirement line shows 0.00 (spec 005 rule 24b): a person who chose 0% is then contributing it, and `rate_framing` leaves the decision out.
- The two rates are compared by value at two places: a stub at 3.99 against a chosen 4 differs, and the explanation says the chosen rate is not in effect yet. Spec 015's check-in compares cents with a one-cent tolerance instead, because it judges whether payroll applied the election; the explanation only states both rates.
- A model that echoes a citation passage's figures (for example "$8,000" catch-up for a 30-year-old) fails verification unless the figure is also a result or input value; the prompt tells it not to.

## Out of scope

- Explaining check-in findings (`finding_id`, M8).
- Caching across users or reusing an explanation after the decision's version changes: each version is explained on its own.
