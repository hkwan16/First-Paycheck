# 002: Sync pipeline, Plaid, webhooks and jobs

Status: Implemented, M1. The live Plaid sandbox path (`tests/integration/test_plaid_sandbox.py`, `scripts/record_plaid_fixtures.py`) is written but has not been run against Plaid, because no sandbox keys were available when it was built.

## Goal

Bring a user's bank data into First Paycheck and keep it current. A linked institution becomes a `sync_items` row with an encrypted Plaid access token; a background job pulls its accounts, transactions, balances and holdings through one provider interface and writes them with idempotent upserts; a verified Plaid webhook or a manual request queues the next incremental sync. Code: `api/sync/` (`provider.py`, `pipeline.py`, `crypto.py`, `plaid/`), `api/jobs/` (`queue.py`, `worker.py`, `scheduler.py`, `registry.py`, `handlers/`), routes in `api/app/routers/{sync,accounts,jobs}.py`, migrations `0002_core` and `0006_webhook_fn` (spec 001).

## Inputs

| Input | Type | Valid range |
|---|---|---|
| Plaid `public_token` | string from Plaid Link | 1-512 characters; exchanged once |
| `sandbox_institution_id` | string | Non-production only, for example `ins_109508` (First Platypus Bank) |
| `institution_name` | string, optional | 1-200 characters, from Link's `onSuccess` metadata |
| Provider pages | `TransactionPage` (below) | Any number of pages; `has_more` false on the last |
| Plaid amounts | JSON numbers in dollars | Parsed as `Decimal`, never `float` |
| Webhook request | raw body bytes plus the `Plaid-Verification` header | Body up to 1 MB |
| `PLAID_TOKEN_KEY` | comma-separated Fernet keys, newest first | At least one key |

## Outputs

- `SyncProvider` DTOs (`api/sync/provider.py`), all money as integer cents:
  `ProviderAccount(provider_account_id, name, kind, mask)`,
  `ProviderTransaction(provider_txn_id, provider_account_id, posted_at, amount_cents, merchant_raw, merchant_clean, pending)`,
  `RemovedTransaction(provider_txn_id, provider_account_id)`,
  `TransactionPage(added, modified, removed, next_cursor, has_more)`,
  `ProviderBalance(provider_account_id, balance_cents)`,
  `ProviderHolding(provider_account_id, security_id, name, ticker, quantity, value_cents, cost_basis_cents, as_of)`.
- `SyncResult` from `run_sync`: counts of accounts, added, modified, removed, skipped transactions, balance snapshots and holdings, plus `outcome` (`synced`, `stale`, `item_missing`, `login_required`). It is the `sync.*` job's `result`.
- Rows in `sync_items`, `accounts`, `transactions`, `balance_snapshots`, `holdings`, `jobs` (spec 001).
- Routes (all JSON, errors as `{"error": {"code", "message"}}`, another user's row is 404):

| Route | Success | Errors |
|---|---|---|
| `POST /sync/link-token` | 200 `{link_token, expiration}` | 503 `plaid_unavailable` |
| `POST /sync/items` | 201 `{item, job_id}`; queues `sync.initial` | 409 `item_already_linked`, 422, 502 `plaid_error`, 503 |
| `DELETE /sync/items/{id}` | 204 | 404 |
| `POST /sync/items/{id}/sync` | 202 `{job_id}`; queues `sync.incremental` | 404 |
| `POST /sync/webhook` | 200 `{status: "ok"}` | 401 `invalid_webhook` |
| `GET /accounts` | 200 list with latest balance and role | - |
| `PATCH /accounts/{id}` | 200 updated account | 404, 422 |
| `GET /jobs/{id}` | 200 `{id, kind, status, progress, result, last_error, created_at, finished_at}` | 404 |

`GET /transactions` and `PATCH /transactions/{id}` are specified in spec 003.

## Rules

### Provider interface and Plaid mapping

1. `SyncProvider` has four methods: `fetch_accounts()`, `fetch_transactions(cursor)` returning one `TransactionPage`, `fetch_balances()`, `fetch_holdings()`. The pipeline is the only caller; Plaid and the later CSV provider both implement it.
2. **Dollars to cents.** Plaid JSON is parsed with `parse_float=Decimal`; `cents = (dollars * 100).quantize(1, ROUND_HALF_UP)`. `ROUND_HALF_UP` rounds a tie away from zero, so `-0.005` becomes `-1`.
3. **Sign.** Plaid's convention is kept unchanged: `amount_cents > 0` is money out (spec 001 rule 21). Balances are the provider's `current` balance (falling back to `available` when `current` is null); an account with neither is skipped for that sync.
4. **Account kinds** from Plaid `type`/`subtype`:

   | Plaid type | Subtype | `account_kind` |
   |---|---|---|
   | `depository` | `savings`, `money market`, `cd`, `hsa` | `savings` |
   | `depository` | anything else | `checking` |
   | `credit` | any | `credit` |
   | `loan` | any | `credit` (a liability; its balance is the amount owed, spec 001 rule 22) |
   | `investment` | `401a`, `401k`, `403B`, `457b`, `ira`, `roth`, `roth 401k`, `sep ira`, `simple ira`, `keogh`, `pension`, `retirement`, `thrift savings plan`, `tsp`, `lif`, `lira`, `rrsp`, `rrif`, `tfsa` | `retirement` |
   | `investment` | anything else | `investment` |
   | `other` or unknown | any | skipped, logged; its transactions are skipped too |

5. **Merchant fields.** `merchant_raw` is Plaid's `name`; `merchant_clean` is `merchant_name` (null when Plaid has none); `merchant_norm` is `normalize_merchant(merchant_raw)` (spec 003).
6. **Masks** keep only a 2-4 digit mask; anything else is stored as null (spec 001 check).
7. **Balances** come from `/accounts/get` (Plaid's cached balances, refreshed with each transactions update), fetched once per sync and shared by `fetch_accounts` and `fetch_balances`. `/accounts/balance/get` (a real-time, per-call billed product) is not used.
8. **Holdings** come from `/investments/holdings/get`. Plaid errors meaning "this item has no investments" (`PRODUCTS_NOT_SUPPORTED`, `NO_INVESTMENT_ACCOUNTS`, `PRODUCT_NOT_ENABLED`, `INVALID_PRODUCT`, `ADDITIONAL_CONSENT_REQUIRED`) return an empty list. `as_of` is the holding's `institution_price_as_of`, else the sync date. `quantity` stays a `Decimal`.
9. **Plaid errors** become typed exceptions: `PRODUCT_NOT_READY` (and a `transactions_update_status` of `NOT_READY` on the first page of an item's first sync) raises `RetryLater`; `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` raises `PaginationMutated`; `ITEM_LOGIN_REQUIRED` raises `ItemLoginRequired`; every other error raises `PlaidError(code, type, message, request_id)`. No exception message ever carries an access token or a request body.

### Pipeline (`run_sync`)

10. **Read, fetch, write.** One short user session reads the item (cursor, encrypted token). Network calls run with no database transaction open. A second user session writes everything and commits once.
11. **Pagination.** Pages are fetched from the item's committed cursor until `has_more` is false. On `PaginationMutated` the pipeline discards every page fetched so far and restarts from the committed cursor, at most 3 restarts; a fourth raises `RetryLater`. (Plaid's documented recovery; it lives in the pipeline rather than the Plaid provider so every provider gets it.)
12. **Cursor last.** The new cursor is written in the same transaction as the data, after every page has been applied, so a crash leaves the old cursor and the next run replays the same pages.
13. **Optimistic concurrency.** The write transaction locks the item (`SELECT ... FOR UPDATE`). If its cursor is no longer the one the fetch started from, another sync already advanced it: nothing is written and the outcome is `stale`.
14. **Upserts.** Accounts by `(sync_item_id, provider_account_id)`, updating `name`, `kind`, `mask`; `role` and `is_active` belong to the user and are never overwritten. Transactions by `(account_id, provider_txn_id)`, page by page in order: added, then modified, then removed. A modified transaction keeps its category when its `merchant_norm` is unchanged or its `category_source` is `user`; otherwise the category, source and confidence are cleared so categorization runs again. Removed transactions are deleted. Transactions for an unknown or skipped account are counted as `skipped`.
15. **Snapshots.** One `balance_snapshots` row per account per sync at `as_of` = the sync time (upsert on `(account_id, as_of)`). Holdings upsert on `(account_id, as_of, security_id)`; holdings of a synced account and date that the provider no longer returns are deleted.
16. **Follow-up jobs.** After the write the item gets `cursor`, `last_synced_at = now()` and `status = 'active'`, and the pipeline enqueues `categorize.run` and `recurring.detect` for the user unless one of that kind is already queued.
17. **Missing item.** If the item was deleted before the job ran, the outcome is `item_missing` and the job succeeds.
18. **Login required.** `ItemLoginRequired` sets the item's `status` to `login_required`; the job succeeds with that outcome and is not retried.

### Token encryption (`sync/crypto.py`)

19. `PLAID_TOKEN_KEY` holds one or more Fernet keys, newest first. Encryption uses the first key; decryption tries each (`MultiFernet`), so a key can be rotated by prepending a new key, re-encrypting (`TokenCipher.rotate`), then removing the old one.
20. Decrypted tokens are `SecretStr`: they never appear in a `repr`, a log line, an exception message, a job payload or result, or a response. A wrong key or tampered ciphertext raises `TokenDecryptError`.

### Webhook (`sync/plaid/webhook.py`, `POST /sync/webhook`)

21. The `Plaid-Verification` header is a JWT. Its unverified header must have `alg == "ES256"` and a `kid`; any other algorithm (including `HS256` and `none`) is rejected before a key is fetched.
22. The key comes from `/webhook_verification_key/get` for that `kid`, cached for 24 hours. A key with an `expired_at` in the past is rejected.
23. The JWT's signature must verify with that key, its `iat` must be within 5 minutes of now (either direction), and `request_body_sha256` must equal the SHA-256 hex digest of the raw body (constant-time compare).
24. Any failure in rules 21-23 is 401 `invalid_webhook`, and nothing is queued.
25. A verified `TRANSACTIONS` webhook (`SYNC_UPDATES_AVAILABLE`, `DEFAULT_UPDATE`, `INITIAL_UPDATE`, `HISTORICAL_UPDATE`) or `HOLDINGS`/`INVESTMENTS_TRANSACTIONS` `DEFAULT_UPDATE` calls `enqueue_sync_for_plaid_item(item_id)`. Every other verified webhook is acknowledged and ignored. The response is 200 whether or not the item exists, so a webhook never reveals which items are linked.
26. `enqueue_sync_for_plaid_item(text)` is `SECURITY DEFINER`, `SET search_path = public, pg_temp`, revoked from `PUBLIC` and granted `EXECUTE` to `app_api` only (spec 001). The webhook route calls it inside a transaction that runs `SET LOCAL ROLE app_api` and has no other privilege. It inserts one `sync.incremental` job unless one for that item is already queued.

### Routes

27. `POST /sync/items` takes exactly one of `public_token` or `sandbox_institution_id`. The sandbox field is rejected with 422 when `APP_ENV=production`. The access token is encrypted before it touches the database. A `provider_item_id` that is already linked is 409 `item_already_linked`. The response's `job_id` is the `sync.initial` job, whose idempotency key is `sync.initial:<item id>`.
28. `DELETE /sync/items/{id}` asks Plaid to remove the item (best effort: a Plaid failure is logged, not returned) and deletes the row; `ON DELETE CASCADE` removes its accounts, transactions, snapshots and holdings (spec 001 rule 25).
29. `POST /sync/items/{id}/sync` returns the already-queued `sync.incremental` job for that item when there is one, otherwise a new one.
30. `GET /accounts` lists the user's accounts ordered by institution, then name, each with its latest balance snapshot (`balance_cents`, `balance_as_of`, null when none) and institution name.
31. `PATCH /accounts/{id}` accepts `role` (an `account_role` or null) and `is_active`; omitted fields are unchanged. Assigning `emergency_fund` moves it: the user's previous emergency-fund account loses the role in the same transaction (spec 001 allows one).

### Jobs (`jobs/`)

32. `enqueue` runs in the caller's user session, under RLS. With an idempotency key, a second enqueue returns the first job instead of inserting (`ON CONFLICT DO NOTHING` on the partial unique index).
33. `dequeue` runs on the privileged connection: it claims the oldest due queued job with `FOR UPDATE SKIP LOCKED`, sets `status = 'running'`, `attempts = attempts + 1`, `started_at` and `heartbeat_at`. Two workers never claim the same job.
34. `complete` sets `succeeded`, `progress = 100`, `result`, `finished_at`. `fail` after the n-th attempt sets `dead` when `n >= 5`, otherwise `queued` with `run_after = now() + min(2^n * 30 s, 1 h)`. `RetryLater(after)` is a failure whose delay is `max(backoff, after)`. `last_error` is the exception type and message, truncated to 500 characters.
35. The worker (`python -m jobs.worker`) polls every second when idle, runs each handler with `user_session_for(job.user_id)`, writes `heartbeat_at` every 30 s while a handler runs, and on SIGTERM or SIGINT finishes the current job and exits 0.
36. `schedule.tick` is a system job (`user_id` null). Under `pg_try_advisory_xact_lock(42)` it requeues `running` jobs whose heartbeat is more than 10 minutes old (as a failed attempt, so rule 34 applies) and queues the next tick 60 s later unless one is queued. The worker queues a tick on startup when none is queued or running.
37. Handlers in M1: `sync.initial` and `sync.incremental` (`run_sync`), `categorize.run` (spec 003), `recurring.detect` (a stub until M5 that succeeds with `{"status": "not_implemented", "detected": 0}`), `schedule.tick`.

## Hand-worked examples

| # | Test | Input | Expected |
|---|---|---|---|
| 1 | `test_cents_from_plaid_amounts` | `89.4`, `12`, `0.005`, `-0.005`, `4.335`, `-1234.567` | `8940`, `1200`, `1`, `-1`, `434`, `-123457` |
| 2 | `test_account_kind_mapping` | `depository/checking`, `depository/cd`, `credit/credit card`, `loan/student`, `investment/401k`, `investment/brokerage`, `other/other` | `checking`, `savings`, `credit`, `credit`, `retirement`, `investment`, skipped |
| 3 | `test_two_pages_added_modified_removed` | Page 1 (cursor null): add t1 $12.00, t2 $5.50; page 2: modify t1 to $13.25, remove t2, add t3 -$1,000.00 | Rows t1 1325, t3 -100000; t2 absent; cursor = page 2's `next_cursor` |
| 4 | `test_cursor_saved_only_after_last_page` | Page 2 raises a provider error | Cursor still null; no transactions written |
| 5 | `test_rerun_is_idempotent` | Example 3 run twice from the same cursor | Same rows and values; one more balance snapshot per account |
| 6 | `test_mutation_restarts_from_committed_cursor` | Page 2 raises `PaginationMutated` once | Pages restart at the committed cursor; final rows as example 3 |
| 7 | `test_backoff_schedule` | Failures after attempts 1, 2, 3, 4, 5 | Delays 60 s, 120 s, 240 s, 480 s, then `dead` |
| 8 | `test_webhook_*` | Valid; body changed after signing; `iat` 6 minutes old; unknown `kid`; `alg: HS256` | 200; 401; 401; 401; 401 |
| 9 | `test_webhook_unknown_item_is_200` | Valid signature, `item_id` not linked | 200, no job queued |

Arithmetic for example 1: `89.4 * 100 = 8940`; `0.005 * 100 = 0.5`, a tie, rounds away from zero to `1`; `4.335 * 100 = 433.5` to `434`; `-1234.567 * 100 = -123456.7` to `-123457`. Because the JSON is read as `Decimal`, `4.335` is exactly `4.335`, not `4.33499...` as a binary float.

Arithmetic for example 7: `2^1 * 30 = 60`, `2^2 * 30 = 120`, `2^3 * 30 = 240`, `2^4 * 30 = 480`; the fifth failure reaches the limit of 5 attempts. The 1-hour cap (`2^7 * 30 = 3840 > 3600`) is never reached with 5 attempts but bounds a later change to the limit.

## Edge cases

- A page whose `added` list repeats a transaction already stored (a replay after a crash) updates it in place.
- A transaction removed by Plaid that was never stored is ignored.
- An item whose institution returns no investments yields zero holdings and no error.
- A webhook with no `Plaid-Verification` header, an unparsable JWT, or a body that is not JSON is 401 (signature first, then parsing).
- `POST /sync/items` with both or neither of `public_token` and `sandbox_institution_id` is 422.
- `PATCH /accounts/{id}` with an empty body returns the account unchanged.
- A job whose kind has no registered handler fails with `last_error` naming the kind, and backs off like any failure.

## Out of scope

- The CSV provider (M5) and Plaid update mode for re-authenticating a `login_required` item.
- Plaid production access, `/accounts/balance/get`, investment transactions.
- Pruning terminal jobs (spec 001 open question 4).
- Recurring detection beyond the stub (M5).
