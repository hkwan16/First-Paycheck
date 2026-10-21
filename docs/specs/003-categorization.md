# 003: Categorization, the LLM gateway and transaction routes

Status: Implemented, M1. The live Haiku path (`llm_live`) is written but has not been run against the Anthropic API, because no key was available when it was built.

## Goal

Give every synced transaction a spending category the user can trust and correct. Plain-string rules (the user's own, then seeded ones) label most transactions; only merchants no rule knows go to Claude Haiku 5.5, in batches, through the one LLM gateway; a user's correction becomes a rule, relabels the same merchant's other transactions, and keeps that merchant away from the LLM from then on. Code: `api/sync/categorize.py`, `api/sync/categories.py`, `api/llm/` (`gateway.py`, `schemas.py`, `cost.py`, `prompts.py`, `prompts/categorize/v1.md`), `api/db/seed/category_rules.csv`, routes in `api/app/routers/transactions.py`, eval suite `evals/suites/categorization_rules.py`.

## Inputs

| Input | Type | Valid range |
|---|---|---|
| `merchant_raw` | string | Any provider description, possibly empty |
| Category rules | rows of `category_rules` (spec 001) | `merchant_norm` non-empty and already normalized; `match` `exact` or `prefix`; `category` from the list below |
| User correction | `PATCH /transactions/{id}` body `{category}` | One of the categories below |
| LLM budget | `LLM_DAILY_BUDGET_CENTS` | Integer >= 0, per user per UTC day |

**Categories** (`api/sync/categories.py`, the single source; the LLM schema, the seed loader and the routes all validate against it): `income`, `transfer`, `housing`, `utilities`, `phone_internet`, `groceries`, `dining`, `transport`, `subscriptions`, `insurance`, `healthcare`, `shopping`, `entertainment`, `travel`, `personal_care`, `education`, `gifts_donations`, `fees`, `taxes`, `debt_payment`, `savings_investment`, `other`.

## Outputs

- `normalize_merchant(raw) -> str`.
- `RuleBook.match(merchant_norm) -> CategoryRule | None` (`apply_rules` is the module-level entry point).
- Transactions with `category`, `category_source` (`rule`, `user`, `llm`) and `confidence` (set only for `llm`).
- `categorize.run` job result: `{"rule": n, "llm": n, "reused": n, "unresolved": n, "llm_calls": n, "stopped": null | "budget" | "refused"}`.
- One `llm_calls` row per gateway call, including blocked and failed calls.
- `GET /transactions` page `{items, next_cursor}`; `PATCH /transactions/{id}` `{transaction, rule, relabeled}`.

## Rules

### Normalization

1. `normalize_merchant(raw)`: apply Unicode NFKC and lowercase; delete apostrophes (`'` and U+2019); split into tokens on every run of characters that is not a letter, a digit, `.` or `&`; drop every token that contains a digit (this removes store numbers, dates and reference codes); strip `.` from both ends of each token and drop tokens left empty; while more than one token remains and the first is a payment-processor prefix (`sq`, `tst`, `pp`, `sp`, `pos`, `checkcard`), drop it; join with single spaces; cut to 128 characters and strip trailing spaces.
2. The result may be empty (for example `"#1234"`). An empty `merchant_norm` matches no rule and is never sent to the LLM; the transaction stays uncategorized until the user labels it, and that label creates no rule.

### Rules and precedence

3. A rule is a plain string, never a pattern. An `exact` rule matches when `merchant_norm == rule`. A `prefix` rule matches when `merchant_norm == rule` or `merchant_norm` starts with `rule + " "` (whole tokens only: `uber` matches `uber trip` but not `ubereats` or `uber.com`).
4. Precedence: user exact, user prefix, seed exact, seed prefix, then the LLM. Among prefix rules of one source the longest wins (`uber eats` beats `uber` for `uber eats order`). The first level that matches decides; lower levels are not consulted.
5. Matching is done in memory: the categorizer loads the user's rules and the seed rules once per run (RLS shows a user exactly those) and, for each merchant, looks up the exact string and then each of its whole-token prefixes from longest to shortest in hash maps.
6. A transaction labeled by any rule gets `category_source = 'rule'` and null confidence.

### The categorize job (`categorize.run`)

7. It considers only the user's transactions with `category IS NULL`; labeled transactions are never relabeled by the job.
8. Rules first (rules 3-6). Then, for each remaining non-empty `merchant_norm`, if the user already has a transaction with that `merchant_norm` labeled by the LLM, the newest such label and confidence are copied (`reused`, no call). The rest go to the LLM.
9. **Batching.** Distinct remaining merchants are sent 50 per call, in alphabetical order. Each item carries only an id (1-50 within the batch), the `merchant_norm`, one sample amount in dollars (`"12.34"`, the newest transaction's `amount_cents / 100`, sign kept) and that transaction's date. No account names, masks, ids or raw descriptions are sent.
10. The model returns `{"items": [{"id", "category", "confidence"}]}` (`CategoryBatch`). Every uncategorized transaction with that `merchant_norm` gets the category, `category_source = 'llm'` and the confidence rounded half-up to 3 decimals. Ids outside the batch are ignored; merchants the model skipped stay uncategorized.
11. LLM labels never become `category_rules` rows. Only user corrections do.
12. **Stopping.** A budget block stops the job's LLM work (`stopped: "budget"`), and a refusal skips that batch (`stopped: "refused"` if any batch was refused); the job still succeeds and the remaining merchants stay uncategorized. A schema error or an API error fails the job so the queue retries it (spec 002 rule 34); batches already written stay written.

### User corrections (`PATCH /transactions/{id}`)

13. The transaction gets the new category, `category_source = 'user'` and null confidence.
14. When its `merchant_norm` is non-empty, the user's `exact` rule for that `merchant_norm` is created or replaced with the new category (`source = 'user'`).
15. Every other transaction of the user with the same `merchant_norm` and a `category_source` other than `user` is relabeled to the new category with `category_source = 'rule'` and null confidence. Transactions the user labeled individually are left alone.
16. The response carries the updated transaction, the rule (`{merchant_norm, category}` or null) and the number of siblings relabeled. Because the rule is a user exact rule, rule 4 means that merchant never reaches the LLM again.

### `GET /transactions`

17. Filters, all optional and combined with AND: `account_id`; `start` and `end` (inclusive `posted_at` dates; `start > end` is 422); `category`; `min_confidence` (0-1), which keeps transactions whose effective confidence is at least the value, where a `rule` or `user` label counts as 1 and an uncategorized transaction is excluded.
18. Order is `posted_at DESC, id DESC`. `limit` is 1-200 (default 50). `next_cursor` is an opaque token encoding the last row's `(posted_at, id)`; passing it returns the rows strictly after that position. A malformed cursor is 422. `next_cursor` is null on the last page.

### LLM gateway (`llm/gateway.py`)

19. `llm/gateway.py` is the only module that imports `anthropic`. Model ids come from settings (`LLM_MODEL_CATEGORIZE`, ...), never literals.
20. Prompts live in `llm/prompts/<name>/vN.md` with YAML front matter: `version` (`<name>/vN`, recorded as `llm_calls.prompt_version`), `model` (the settings purpose: `extract`, `categorize` or `explain`), `effort` (`low`, `medium`, `high`), `max_tokens` (positive integer), `schema` (a class name in `llm/schemas.py`). The loader rejects a file with a missing or unknown field or an empty body.
21. **Budget first.** Before any HTTP request, the gateway sums the user's `cost_microcents` over the current UTC day. At or above `LLM_DAILY_BUDGET_CENTS * 1,000,000` it writes a `budget_blocked` row with zero tokens and raises `LLMBudgetExceeded`. A call that starts under budget may finish over it; the next call is blocked.
22. **Request.** `messages.create` with the system prompt as one text block marked `cache_control: {"type": "ephemeral"}`, the request as one user message, `max_tokens` and `output_config = {"effort": <effort>, "format": {"type": "json_schema", "schema": transform_schema(Schema)}}`. No temperature, no prefill, no thinking parameter.
23. **Response.** `stop_reason == "refusal"` is checked before any output is read: it writes a `refusal` row and raises `LLMRefused`. Otherwise the first text block is validated against the schema; invalid JSON, a schema violation or a missing text block writes a `schema_error` row and raises `LLMSchemaError`. Success writes an `ok` row.
24. **Errors.** Rate limits, 5xx, timeouts and connection failures (after the SDK's 2 retries) write an `api_error` row and raise `LLMUnavailable`; other 4xx write `api_error` and raise `LLMError`.
25. **Ledger.** Every row records purpose, model, prompt version, `input_tokens` (uncached input plus cache writes), `output_tokens`, `cache_read_tokens`, `cost_microcents`, `latency_ms`, status and the job id. It is written in its own short user session and committed immediately, so a later failure in the caller cannot erase a charge. No prompt or output text is stored.
26. **Cost.** `llm/cost.py` holds per-model prices in US dollars per million tokens: `claude-haiku-5-5` input 0.10, output 0.50, cache read 0.01, cache write 0.125; `claude-sonnet-5-5` input 2.00, output 10.00, cache read 0.20, cache write 2.50 (Anthropic list prices for prompts up to 100K tokens; cache writes are 1.25x input for the 5-minute TTL). `cost_microcents = round_half_up(sum(tokens * price) * 100)`, computed in `Decimal`. A model missing from the table raises at startup of the call, not silently zero.
27. **Fake.** `LLM_FAKE=true` selects `FakeGateway`, which runs the same budget check and ledger code and replaces only the HTTP call: it answers from `api/tests/fixtures/llm/categorize.json` (merchant to category and confidence) and labels any other merchant `other` with confidence 0.5. Its rows record model `fake` at zero cost.

## Hand-worked examples

### Normalization (`test_normalize_merchant`)

| Raw | `merchant_norm` |
|---|---|
| `NETFLIX.COM #1234` | `netflix.com` |
| `STARBUCKS STORE 05721 SEATTLE WA` | `starbucks store seattle wa` |
| `SQ *BLUE BOTTLE COFFEE 12` | `blue bottle coffee` |
| `McDonald's F12345` | `mcdonalds` |
| `Uber 063015 SF**POOL**` | `uber sf pool` |
| `TST* Joe's Diner` | `joes diner` |
| `AMZN Mktp US*2K39H1` | `amzn mktp us` |
| `   Café  Rouge  ` | `café rouge` |
| `#1234` | (empty) |
| `SQ` | `sq` |

Working for row 2: tokens `starbucks`, `store`, `05721`, `seattle`, `wa`; `05721` contains digits and is dropped. Row 4: the apostrophe is deleted first, giving `mcdonalds`; `f12345` contains digits. Row 7: `us*2k39h1` splits at `*` into `us` and `2k39h1`; the second contains digits. Row 10: `sq` is the only token, so the prefix rule keeps it.

### Precedence (`test_precedence`)

Rules: user exact `uber eats order` -> `groceries`; user prefix `uber` -> `travel`; seed exact `uber eats order` -> `dining`; seed prefix `uber` -> `transport`; seed prefix `uber eats` -> `dining`; seed prefix `netflix` -> `subscriptions`.

| `merchant_norm` | Category | Why |
|---|---|---|
| `uber eats order` | `groceries` | user exact beats everything |
| `uber trip` | `travel` | user prefix beats seed rules |
| `netflix` | `subscriptions` | seed prefix equal to the whole string |
| `netflix.com` | none (LLM) | `netflix` is not a whole-token prefix of `netflix.com` |
| `ubereats` | none (LLM) | not a whole-token prefix |

Without the two user rules: `uber eats order` -> `dining` (seed exact), `uber eats pickup` -> `dining` (longest seed prefix `uber eats`), `uber trip` -> `transport`.

### Cost (`test_cost_microcents`)

| Model | input / output / cache read / cache write tokens | `cost_microcents` |
|---|---|---|
| `claude-haiku-5-5` | 1,000 / 500 / 0 / 0 | 35,000 |
| `claude-haiku-5-5` | 200 / 0 / 2,000 / 0 | 4,000 |
| `claude-haiku-5-5` | 0 / 0 / 0 / 2,000 | 25,000 |
| `claude-sonnet-5-5` | 1,234 / 567 / 0 / 0 | 813,800 |
| `claude-haiku-5-5` | 3 / 0 / 0 / 0 | 30 |

Working: row 1 `(1000 * 0.10 + 500 * 0.50) * 100 = (100 + 250) * 100 = 35000`. Row 2 `(200 * 0.10 + 2000 * 0.01) * 100 = (20 + 20) * 100 = 4000`. Row 3 `2000 * 0.125 * 100 = 25000`. Row 4 `(1234 * 2 + 567 * 10) * 100 = (2468 + 5670) * 100 = 813800`. Row 5 `3 * 0.10 * 100 = 30`. One microcent is a millionth of a cent, so 35,000 microcents is 0.035 cents.

### Corrections (`test_fix_relabels_siblings`)

User A has three `netflix.com` transactions: t1 `llm`/`entertainment` 0.62, t2 `rule`/`entertainment`, t3 `user`/`entertainment`. A patches t1 to `subscriptions`. Result: t1 `user`/`subscriptions`; t2 `rule`/`subscriptions`; t3 unchanged; a user exact rule `netflix.com -> subscriptions`; `relabeled = 1`. A new `netflix.com` transaction synced later is labeled `subscriptions` by that rule and never reaches the gateway.

## Edge cases

- An empty batch never calls the gateway.
- A budget of 0 blocks every call; the job succeeds with every unknown merchant unresolved.
- `PATCH /transactions/{id}` with a category outside the list is 422; with another user's id is 404.
- A transaction patched to the category it already has still becomes `user` and still writes the rule.
- Seed rows are visible to every user and writable by none (spec 001 example 8).

## Out of scope

- The Batches API for initial histories over 500 unknown merchants (planned; M1 uses synchronous calls).
- The category-to-bucket mapping for `/spending/summary` (M5).
- Deleting or listing a user's rules through the API.
- Recategorizing already-labeled transactions when seed rules change.
