# 003: Categorization, the LLM gateway and transaction routes

Status: Implemented, M1. Categorization moved from Claude Haiku 5.5 to Claude Sonnet 5.5 in M10 (issue #136): the first live `categorization` eval with `claude-haiku-5-5` scored `accuracy` 0.9573 and `llm_accuracy` 0.8947 (it called `kqed membership` subscriptions instead of gifts_donations and `corner bodega` other instead of groceries), and on production it labeled Rocket Money (a $21.54 charge) a savings transfer at 0.90 confidence and Mosquito Joe (pest control) other. The same eval on `claude-sonnet-5-5` on October 29 scored `accuracy` 0.9670 and `llm_accuracy` 0.9474 for 1.0 cents; `corner bodega` became groceries and `kqed membership` (5 rows) is still subscriptions. The baseline still holds the targets. Rules 3a-3c (direction-aware precedence and the `contains` match) and the generic bank descriptors (rule 5a) added in M10 after the October 22 production run with Plaid's `user_transactions_dynamic` sandbox user, whose weekly paycheck `Sweetgreen inc payroll ppd id` (money in) was labeled `dining` by the seed rule `sweetgreen` and whose loan ledgers left 256 of 316 rows uncategorized.

## Goal

Give every synced transaction a spending category the user can trust and correct. Plain-string rules (the user's own, then seeded ones) label most transactions; only merchants no rule knows go to Claude Sonnet 5.5 (`LLM_MODEL_CATEGORIZE`, default `claude-sonnet-5-5`), in batches, through the one LLM gateway; a user's correction becomes a rule, relabels the same merchant's other transactions, and keeps that merchant away from the LLM from then on. Code: `api/sync/categorize.py`, `api/sync/categories.py`, `api/llm/` (`gateway.py`, `schemas.py`, `cost.py`, `prompts.py`, `prompts/categorize/v2.md`), `api/db/seed/category_rules.csv`, routes in `api/app/routers/transactions.py`, eval suite `evals/suites/categorization_rules.py`.

## Inputs

| Input | Type | Valid range |
|---|---|---|
| `merchant_raw` | string | Any provider description, possibly empty |
| `amount_cents` | integer | Any; positive is money out, negative money in (spec 001 rule 21) |
| Category rules | rows of `category_rules` (spec 001) | `merchant_norm` non-empty and already normalized; `match` `exact`, `prefix` or `contains` (`contains` only on a seed row for `income` or `transfer`, rule 3c); `category` from the list below |
| User correction | `PATCH /transactions/{id}` body `{category}` | One of the categories below |
| LLM budget | `LLM_DAILY_BUDGET_CENTS` | Integer >= 0, per user per UTC day |

**Categories** (`api/sync/categories.py`, the single source; the LLM schema, the seed loader and the routes all validate against it): `income`, `transfer`, `housing`, `utilities`, `phone_internet`, `groceries`, `dining`, `transport`, `subscriptions`, `insurance`, `healthcare`, `shopping`, `entertainment`, `travel`, `personal_care`, `education`, `gifts_donations`, `fees`, `taxes`, `debt_payment`, `savings_investment`, `other`.

## Outputs

- `normalize_merchant(raw) -> str`.
- `RuleBook.match(merchant_norm, *, amount_cents) -> CategoryRule | None` (`apply_rules(merchant_norm, rules, *, amount_cents)` is the module-level entry point).
- Transactions with `category`, `category_source` (`rule`, `user`, `llm`) and `confidence` (set only for `llm`).
- `categorize.run` job result: `{"rule": n, "llm": n, "reused": n, "unresolved": n, "llm_calls": n, "stopped": null | "budget" | "refused" | "no_model"}`.
- One `llm_calls` row per gateway call, including blocked and failed calls.
- `GET /transactions` page `{items, next_cursor}`; `PATCH /transactions/{id}` `{transaction, rule, relabeled}`.

## Rules

### Normalization

1. `normalize_merchant(raw)`: apply Unicode NFKC and lowercase; delete apostrophes (`'` and U+2019); split into tokens on every run of characters that is not a letter, a digit, `.` or `&`; drop every token that contains a digit (this removes store numbers, dates and reference codes); strip `.` from both ends of each token and drop tokens left empty; while more than one token remains and the first is a payment-processor prefix (`sq`, `tst`, `pp`, `sp`, `pos`, `checkcard`), drop it; join with single spaces; cut to 128 characters and strip trailing spaces.
2. The result may be empty (for example `"#1234"`). An empty `merchant_norm` matches no rule and is never sent to the LLM; the transaction stays uncategorized until the user labels it, and that label creates no rule.

### Rules and precedence

3. A rule is a plain string, never a pattern. An `exact` rule matches when `merchant_norm == rule`. A `prefix` rule matches when `merchant_norm == rule` or `merchant_norm` starts with `rule + " "` (whole tokens only: `uber` matches `uber trip` but not `ubereats` or `uber.com`). A `contains` rule matches when its tokens appear as a run of whole tokens anywhere in `merchant_norm`: equal to it, at its start or end, or between two spaces (`payroll` matches `sweetgreen inc payroll ppd id` and `ppd id` matches it too, but `payroll` does not match `payrolls inc`). Whole tokens, as for `prefix`, so a short word never fires inside a longer one.
3a. **Direction.** A transaction is money in when `amount_cents < 0` and money out otherwise (a zero amount counts as money out). Precedence (rule 4) depends on the direction.
3b. **Why direction matters.** Money in at a name that starts like a merchant's is usually a refund and belongs in that merchant's spending category, so spending rules apply to money in as to money out and refunds keep netting their bucket (spec 007 rule 22: the recorded `user_good` history's United Airlines refund, -50,000, is `travel`). But an employer can be named like a merchant: the dynamic sandbox user's weekly paycheck `Sweetgreen inc payroll ppd id` is money in, and the seed prefix rule `sweetgreen -> dining` would make it a negative dining charge. Words such as `payroll` or `ppd id` anywhere in a money-in description say it is pay, not a refund; the seed `contains` rules (rule 3c) carry those words and, for money in, rank above every other seed rule.
3c. **`contains` is for seed income and transfer rules, money in only.** A `contains` rule must be a seed row (`user_id` null, `source = 'seed'`) whose category is `income` or `transfer` (the categories whose spec 007 bucket, rule 20, is `income` or `transfer`: `sync/categories.py:INCOME_TRANSFER_CATEGORIES`, derived from `CATEGORY_BUCKETS`). It applies to money-in transactions only. The seed loader refuses any other row (`SeedError`), `RuleBook` refuses one (`ValueError`), and the database refuses one (`ck_category_rules_contains_is_seed_money_in`, migration `0016_rule_match_contains`). A user never writes one: `PATCH /transactions/{id}` takes only a category and always writes an `exact` rule (rule 14), so the route has no match kind to validate.
4. **Precedence.** For money out: user exact, user prefix, seed exact, seed prefix, then the LLM (a `contains` rule never applies to money out). For money in: user exact, user prefix, seed contains, seed exact, seed prefix, then the LLM. Every `exact` and `prefix` rule applies in both directions, whatever its category. Among prefix rules of one source the longest wins (`uber eats` beats `uber` for `uber eats order`); among `contains` rules the one with more tokens wins, then the one that starts further left. The first level that matches decides; lower levels are not consulted.
5. Matching is done in memory: the categorizer loads the user's rules and the seed rules once per run (RLS shows a user exactly those) and, for each transaction, walks the levels of rule 4 for its direction in hash maps: an exact level is one lookup, a prefix level one lookup per whole-token prefix from longest to shortest, the contains level one lookup per run of whole tokens from longest to shortest (leftmost first).
5a. **Generic bank descriptors.** Banks and loan servicers describe their own ledger entries in plain words, not merchant names. The seed rules label them (`category_rules.csv`): `monthly payment` and `payment` (exact, `transfer`: a loan or card payment received is the other side of money that left the user's checking account); `interest charged` (exact, `fees`: interest is a cost, and `fees` is the category for it, bucket `other`); `interest` (exact, `fees`, and `contains`, `income`); `cash deposit` (exact, `transfer`: cash brought in from outside, not pay); and the `contains` income rules `payroll`, `ppd id`, `direct dep`, `direct deposit`, `salary` and `interest`, beside the `prefix` income rules already there (`payroll`, `direct dep`, `direct deposit`, `interest payment`, ...). **A descriptor with both signs resolves by direction** (rule 4): `interest` money out (interest accrued on a student loan, which Plaid files under bank fees) matches the seed exact rule `interest -> fees`, since a `contains` rule never applies to money out; `interest` money in (interest earned) meets the seed `contains` rule `interest -> income` first, which ranks above the seed exact rule for money in.
6. A transaction labeled by any rule gets `category_source = 'rule'` and null confidence.

### The categorize job (`categorize.run`)

7. It considers only the user's transactions with `category IS NULL`; labeled transactions are never relabeled by the job.
8. Rules first (rules 3-6). The unit of the remaining work is a merchant and a direction (rule 3a): a merchant's money-out and money-in transactions are labeled separately, because a merchant's purchases and its deposits are different things. For each remaining pair with a non-empty `merchant_norm`, if the user already has a transaction with that `merchant_norm` and direction labeled by the LLM, the newest such label and confidence are copied (`reused`, no call); a label is never copied across directions. The rest go to the LLM.
9. **Batching.** Distinct remaining pairs are sent 50 per call, in alphabetical order of `merchant_norm`, money out before money in. Each item carries only an id (1-50 within the batch), the `merchant_norm`, the direction (`"out"` or `"in"`), one sample amount in dollars (`"12.34"`, the newest transaction of that merchant and direction, `amount_cents / 100`, sign kept) and that transaction's date. No account names, masks, ids or raw descriptions are sent. The prompt is `categorize/v2`: it tells the model what the sign and the direction mean, and that money in at a merchant is usually a refund in that merchant's spending category unless the description says pay, payroll, deposit or transfer.
10. The model returns `{"items": [{"id", "category", "confidence"}]}` (`CategoryBatch`). Every uncategorized transaction with that `merchant_norm` and direction gets the category, `category_source = 'llm'` and the confidence rounded half-up to 3 decimals. Ids outside the batch are ignored; items the model skipped stay uncategorized. Any category may label either direction: a money-in item in a spending category is a refund.
11. LLM labels never become `category_rules` rows. Only user corrections do.
12. **Stopping.** A budget block stops the job's LLM work (`stopped: "budget"`), and a refusal skips that batch (`stopped: "refused"` if any batch was refused); the job still succeeds and the remaining merchants stay uncategorized. A schema error or an API error fails the job so the queue retries it (spec 002 rule 34); batches already written stay written.
12a. **No model.** Outside production (development, test, CI and evals), the worker may run with no gateway (no `ANTHROPIC_API_KEY` and `LLM_FAKE` off): the job still runs the rules and the reuse steps, makes no batches, and succeeds with `stopped: "no_model"`; the unknown merchants stay uncategorized until a later run has a model. In production a missing key is a settings error at startup, exactly like `LLM_FAKE` (`app/config.py`, `_production_guards`): `APP_ENV=production` without `ANTHROPIC_API_KEY` refuses to build `Settings`, so neither the API nor the worker starts. On October 29 the key was saved on Render as `ABTHROPIC_API_KEY`; the worker started with no model, logged one warning, and quietly sent every document to manual entry until a manual test found it (issue #133). A gateway call that raises `LLMMisconfigured` (rule 24: the API rejected the key or the model id) ends the LLM work the same way: no further batches, batches already written stay written, `stopped: "no_model"`, and the job succeeds on its first attempt. A missing or rejected key never fails a job.

### User corrections (`PATCH /transactions/{id}`)

13. The transaction gets the new category, `category_source = 'user'` and null confidence.
14. When its `merchant_norm` is non-empty, the user's `exact` rule for that `merchant_norm` is created or replaced with the new category (`source = 'user'`). A user rule ranks above every seed rule in both directions (rule 4).
15. Every other transaction of the user with the same `merchant_norm` and a `category_source` other than `user` is relabeled to the new category with `category_source = 'rule'` and null confidence, in both directions. Transactions the user labeled individually are left alone.
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
24. **Errors.** Rate limits, 5xx, timeouts and connection failures (after the SDK's 2 retries) write an `api_error` row and raise `LLMUnavailable`. A rejected key (401), a key without permission (403) or an unknown model id (404) is configuration that no retry can fix: it writes an `api_error` row, logs at ERROR naming the HTTP status (never the key) and raises `LLMMisconfigured`. Other 4xx write `api_error` and raise `LLMError`.
25. **Ledger.** Every row records purpose, model, prompt version, `input_tokens` (uncached input plus cache writes), `output_tokens`, `cache_read_tokens`, `cost_microcents`, `latency_ms`, status and the job id. It is written in its own short user session and committed immediately, so a later failure in the caller cannot erase a charge. No prompt or output text is stored.
26. **Cost.** `llm/cost.py` holds per-model prices in US dollars per million tokens: `claude-haiku-5-5` input 0.10, output 0.50, cache read 0.01, cache write 0.125; `claude-sonnet-5-5` input 2.00, output 10.00, cache read 0.20, cache write 2.50 (Anthropic list prices for prompts up to 100K tokens; cache writes are 1.25x input for the 5-minute TTL). `cost_microcents = round_half_up(sum(tokens * price) * 100)`, computed in `Decimal`. A model missing from the table raises at startup of the call, not silently zero. Categorization runs on Sonnet; Haiku's price stays in the table because earlier `llm_calls` rows name `claude-haiku-5-5` and the cost examples below still check its arithmetic.
27. **Fake.** `LLM_FAKE=true` selects `FakeGateway`, which runs the same budget check and ledger code and replaces only the HTTP call: it answers from `api/tests/fixtures/llm/categorize.json` (merchant to category and confidence) and labels any other merchant `other` with confidence 0.5. It answers a money-in item the same way, so a fixture merchant such as `united airlines refund` (`travel`) is a refund in its spending category. Its rows record model `fake` at zero cost.

### Evals

28. `categorization-rules` (free): the seed rules alone, each row matched with its amount (rules 3a-4), over the 515 labeled rows of `evals/fixtures/transactions.csv` (`evals/gen/transactions.py`: 500 drawn from a fixed seed, then 15 written by hand for direction and bank language: paychecks from employers named like merchants, `Monthly payment`, `Payment`, `Interest charged`, `Interest` in both directions, `CASH DEPOSIT` and two refunds, whose true label is their spending category). `rules_precision` is the share of rule-labeled rows labeled correctly; `rules_coverage` the share a rule labels.
29. `categorization` (LLM, M10): the same 515 rows the way `categorize.run` labels them, with no database: the seed rules first, then each merchant and direction no rule knows (non-empty `merchant_norm`, rule 8) once, as its newest row (`posted_at`, then `id`, descending), in merchant order with money out first, in batches of 50 `CategorizeItem`s through the real `LLMGateway` with an in-memory ledger that charges the run's `--max-cost-cents` budget before the result is read. The label applies to every row of that merchant and direction (rule 10). A refused batch leaves its merchants unlabeled; any other gateway error is a failure line and the batch is unlabeled. `accuracy` is the share of all rows whose final category equals the label (unlabeled is wrong); `llm_accuracy` the same share over the rows whose merchant went to the model. Targets, held in the baseline until the first live run replaces them: `accuracy` at least 0.90 (the M10 backlog's "500-transaction categorization set at target"), `llm_accuracy` at least 0.80. About 70 merchants go to Sonnet in two batches, about a cent. Without `ANTHROPIC_API_KEY` the suite is unavailable and the runner exits 2. Scoring is unit-tested with a labeler that answers from the labels.

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

Rules: user exact `uber eats order` -> `groceries`; user prefix `uber` -> `travel`; seed exact `uber eats order` -> `dining`; seed prefix `uber` -> `transport`; seed prefix `uber eats` -> `dining`; seed prefix `netflix` -> `subscriptions`; seed prefix `sweetgreen` -> `dining`; seed prefix `united airlines` -> `travel`; seed prefix `zelle` -> `transfer`; seed exact `interest` -> `fees`; seed contains `payroll` -> `income`; seed contains `interest` -> `income`. Amounts in cents, positive is money out.

| `merchant_norm` | Amount | Category | Why |
|---|---|---|---|
| `uber eats order` | 2,000 | `groceries` | user exact beats everything |
| `uber trip` | 1,500 | `travel` | user prefix beats seed rules |
| `netflix` | 1,549 | `subscriptions` | seed prefix equal to the whole string |
| `netflix.com` | 1,549 | none (LLM) | `netflix` is not a whole-token prefix of `netflix.com` |
| `ubereats` | 1,800 | none (LLM) | not a whole-token prefix |
| `` (empty) | 100 | none | an empty merchant matches nothing (rule 2) |
| `uber eats order` | -2,000 | `groceries` | money in: a user rule still beats everything |
| `netflix` | -1,549 | `subscriptions` | a refund: no contains rule matches, so the seed prefix decides |
| `united airlines` | -50,000 | `travel` | a refund: no contains rule matches, so the seed prefix decides |
| `sweetgreen inc payroll ppd id` | -81,000 | `income` | money in: seed contains `payroll` ranks above seed prefix `sweetgreen` |
| `sweetgreen inc payroll ppd id` | 81,000 | `dining` | money out: seed prefix `sweetgreen`; a `contains` rule never applies to money out |
| `sweetgreen` | -1,450 | `dining` | a refund at a restaurant |
| `acme corp payroll` | 5,000 | none (LLM) | money out: `contains` applies to money in only |
| `interest` | 10,788 | `fees` | money out: seed exact |
| `interest` | -12 | `income` | money in: seed contains `interest` ranks above seed exact `interest` (fees) |
| `zelle to alex` | 2,000 | `transfer` | seed prefix; a transfer rule applies both ways |
| `zelle to alex` | -2,000 | `transfer` | the same rule, money in |
| `uber trip` | 0 | `travel` | a zero amount is money out |

Without the two user rules: `uber eats order` -> `dining` (seed exact), `uber eats pickup` -> `dining` (longest seed prefix `uber eats`), `uber trip` -> `transport`.

Between `contains` rules (`test_contains_precedence`): with seed contains `payroll` -> `income` and `online transfer` -> `transfer`, the money-in `payroll online transfer` is `transfer` (two tokens beat one); with seed contains `payroll` -> `income` and `transfer` -> `transfer`, the money-in `payroll transfer` is `income` (one token each, `payroll` starts further left).

### The dynamic sandbox user (`test_dynamic_sandbox_user_with_rules_only`)

Plaid's `user_transactions_dynamic` (a checking account, a credit card and five loans), recorded on 2026-10-22 in `api/tests/fixtures/plaid/recorded/dynamic/` (316 rows, 15 of them pending), synced through `run_sync` and labeled by the seed rules alone, with no model, as a new user's first sync is.

- Before rules 3a-5a: 256 rows uncategorized; the five weekly paychecks `Sweetgreen inc payroll ppd id` (-81,000 each, money in) `dining`; `income` only the two `Interest payment` rows (-12 each).
- After: 52 rows uncategorized. The five paychecks are `income` (seed contains `payroll`), with the two interest payments seven `income` rows. `Monthly payment` (132 rows, money in on the loans) and `Payment` (1, money in on the student loan) are `transfer`; `Interest charged` (68, money out on the loans) and `Interest` (2, money out on the student loan) are `fees`; `CASH DEPOSIT` (1, money in) is `transfer`.
- What is left are merchant names for the model, none with more than four rows: `fcps myschoolbucks food s` (4), then two rows each of `purchase earnin re sc`, `openai chatgpt subscr`, `x eleven xxxxx` and `town cleaners`.

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
- A key the API rejects (an unfunded account answers 401) stops the job after its first batch with `stopped: "no_model"` and one `api_error` row; it does not retry with backoff.
- `PATCH /transactions/{id}` with a category outside the list is 422; with another user's id is 404.
- A transaction patched to the category it already has still becomes `user` and still writes the rule.
- Seed rows are visible to every user and writable by none (spec 001 example 8).
- A money-in `interest charged` (a reversal of interest) meets the seed contains rule `interest -> income` before the seed exact rule `interest charged -> fees`, so it is labeled `income`. It is rare, and the user's fix (a user rule, above every seed rule) puts it where they want it.
- A refund whose description carries a contains word (a merchant's "payroll adjustment refund", money in) is labeled `income`; the user's fix corrects it and the user rule keeps it corrected.
- The model labels a merchant's money out and money in separately (rule 8), so a merchant with purchases and refunds is two items in a batch.

## Out of scope

- The Batches API for initial histories over 500 unknown merchants (planned; M1 uses synchronous calls).
- The category-to-bucket mapping for `/spending/summary` (M5).
- Deleting or listing a user's rules through the API.
- Recategorizing already-labeled transactions when seed rules change. The one exception is the change to direction: migration `0016_rule_match_contains` clears the money-in rows with a spending category and `category_source` `rule` or `llm` (a paycheck the old seed rule labeled `dining`), so the rules pass of the categorize run every sync queues (spec 002, rule 7: it reads every uncategorized row) labels them again under rule 4: the paycheck becomes `income`, a refund such as United Airlines comes back as `travel`. User labels are kept.
