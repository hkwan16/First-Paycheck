# 017: Account deletion and unlinking

Status: Implemented, M10 (backend). The web settings screen calls `DELETE /me` and signs out; the Link screen already calls `DELETE /sync/items/{id}`.

## Goal

Let a user delete their account: every row they own goes, their linked institutions are revoked at Plaid, and nothing queued for them runs afterwards. This settles spec 001 open question 1 with the mechanism spec 007 rule 9 already allows: the decisions trigger lets a delete through only as the cascade from the owner's `auth.users` row. Let a user unlink one institution and leave nothing behind that came from it: no rows, no recurring charge detected only from its transactions, no open check-in finding about them. Code: `api/app/routers/account.py` (`DELETE /me`), `api/sync/revoke.py` (best-effort removal at Plaid, shared with unlinking), migration `0014_delete_account_fn` (`public.delete_user_account(uuid)`), `api/app/errors.py` (a write with a deleted account's token), `api/app/routers/sync.py` (`DELETE /sync/items/{id}`), `api/checkin/engine.py` (retracting findings whose subject is gone), `api/jobs/handlers/sync.py` (a sync for an unlinked item).

## Inputs

| Route | Input |
|---|---|
| `DELETE /me` | None. The user is the verified access token's `sub`; there is no body and no path id, so a user can only ever name themselves. |
| `DELETE /sync/items/{id}` | The item's id (uuid). Another user's item is 404. |

## Outputs

| Route | Success | Errors |
|---|---|---|
| `DELETE /me` | 204, no body | 401 |
| `DELETE /sync/items/{id}` | 204, no body | 401, 404 |

The SQL function `public.delete_user_account(p_user_id uuid) RETURNS boolean`: true when it deleted the `auth.users` row, false when there was none.

## Rules

### Account deletion

1. **Who.** `DELETE /me` deletes the account of the token's `sub` and nobody else's. The route never reads a user id from the request.
2. **Order.** (a) One user session reads the user's `sync_items` that have an access token (id and ciphertext) and commits. (b) With no transaction open, each item is removed at Plaid (`/item/remove`, rule 3). (c) One transaction as `app_api` (`service_session`) calls `public.delete_user_account(sub)`. Revoking first means a failed delete leaves the account in place, and the user can simply retry; deleting first would lose the tokens needed to revoke.
3. **Best effort at Plaid** (`sync/revoke.py:remove_at_provider`, shared with `DELETE /sync/items/{id}`, spec 002 rule 28). A Plaid error, a token that does not decrypt, or Plaid or the token key not being configured is logged at WARNING with the item id (never the token) and the next item is tried. None of these is returned to the user: deleting their data does not depend on Plaid.
4. **The function.** `public.delete_user_account(uuid)` is `SECURITY DEFINER`, owned by the migrating role, `SET search_path = pg_catalog, public, pg_temp`, `EXECUTE` revoked from `PUBLIC`, `anon` and `authenticated` and granted to `app_api` only (`db.rls.restrict_function`). It deletes the `auth.users` row with that id and returns whether one was deleted. A null id raises. It is the third cross-user place after `jobs/queue.py` and `enqueue_sync_for_plaid_item`, and the only one that deletes.
5. **The cascade.** Every user-owned table references `auth.users(id) ON DELETE CASCADE` (spec 001 rule 5), so the one delete removes every row the user owns, in every table with a `user_id` column, in the same transaction. Decisions go too: the cascade fires `decisions_immutable` at trigger depth 2 with the owner's row already gone, which spec 007 rule 9 allows; a direct `DELETE` on `decisions` still raises.
6. **Queued work.** The user's `jobs` rows go with the cascade, so nothing queued for them runs. A handler already running fails on its next write (the foreign key to `auth.users`), and `queue.complete` and `queue.fail` then match no row (they update by id and `status = 'running'`), so the worker carries on.
7. **Other users and ownerless rows.** Another user's rows are untouched. `irs_citations`, seed `category_rules` (`user_id` null) and `schedule.tick` jobs have no owner and are untouched.
8. **Idempotent.** A second `DELETE /me` with a token that is still valid finds no items, the function returns false, and the response is again 204.
9. **A deleted account's token.** The access token stays valid until it expires (Supabase deletes the sessions with the user, so it cannot be refreshed). Reads under it see nothing. A write fails on the foreign key from a `user_id` column to `auth.users`, and the API answers 401 `account_deleted` instead of a 500, so the client signs out.
10. **Rate limit.** None: the route can succeed once per account, and a repeat costs one empty read and one no-op delete.

### Unlinking (`DELETE /sync/items/{id}`, spec 002 rule 28)

11. **Order.** As rule 2: one user session reads the item (404 when it is not the user's) and commits; with no transaction open the item is removed at Plaid when it has a token (rule 3, so an unconfigured Plaid never makes unlinking fail); a second user session deletes the row and queues `recurring.detect` (`enqueue_unless_queued`). An item already deleted by the time of the second session is 404.
12. **Rows.** The `sync_items` row goes with its encrypted token; `ON DELETE CASCADE` removes its `accounts` and their `transactions`, `balance_snapshots` and `holdings`; `goals.account_id` becomes null (spec 001 rule 25). Nothing else references an account.
13. **Recurring charges.** `recurring.detect` deletes every charge whose merchant has no transaction left (spec 009 rule 16), so a charge seen only at the unlinked institution goes; one also billed elsewhere is re-detected from what remains.
14. **Check-in findings.** When the detection has written, it queues a refresh of the month's open check-in (spec 015 rule 15). The refresh retracts, unless the user has acted on it, (a) every condition no finder produces any more (spec 015 rule 10.4: a goal off pace whose goal lost its account is one), and (b) every event finding whose subject is gone: a `recurring_*` finding whose `recurring_charge_id` is no longer one of the user's `recurring_charges`. A finding the user marked done or dismissed is kept as history. Findings about pay stubs, decisions and calendar events do not depend on bank data and are kept.
15. **Queued syncs.** A `sync.*` job still queued for the item runs and succeeds as `item_missing` (spec 002 rule 17), whether or not the worker has a provider configured; it writes nothing.
16. **What stays.** The user's category rules (they belong to merchants, not to an institution), decisions, explanations, goals, calendar events, pay stubs and documents are kept. A plan PDF rendered before the unlink keeps the balances it printed until retention deletes it (spec 016, 7 days).

## Hand-worked examples

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_delete_account_empties_every_user_table` | User A has at least one row in every table with a `user_id` column (found through `information_schema`), including decisions v1 and v2, a queued job and a Plaid item; user B has a row in each too | 204; A has no row in any of those tables and no `auth.users` row; B's counts are unchanged; the item's token was removed at Plaid |
| 2 | `test_delete_account_revokes_every_plaid_item` | A has two Plaid items and a CSV item | Plaid's `item_remove` is called once per Plaid item, with each item's token |
| 3 | `test_delete_account_survives_plaid_failures` | `item_remove` raises a Plaid error, and a second item's token does not decrypt | 204; every row gone |
| 4 | `test_delete_account_without_plaid_configured` | Plaid is not configured; A has one Plaid item | 204; every row gone; a warning names the item |
| 5 | `test_delete_account_twice_is_204` | `DELETE /me` twice with the same token | 204 both times |
| 6 | `test_write_after_deletion_is_401` | `PUT /profile` with A's token after `DELETE /me` | 401 `account_deleted` |
| 7 | `test_only_app_api_may_execute_it` | `has_function_privilege` for `app_api`, `authenticated`, `anon`, `PUBLIC` | true, false, false, false |
| 8 | `test_direct_decision_delete_still_raises` | After the function exists, `DELETE FROM decisions` as the owner | Raises from `decisions_immutable` |
| 9 | `test_running_job_of_a_deleted_user_does_not_stop_the_worker` | The worker claims A's job; A is deleted before the handler writes | The handler fails, the worker's next `run_once` returns normally, no `jobs` row remains for A |
| 10 | `test_unlink_retracts_what_came_from_the_item_on_the_next_refresh` | The November user (spec 015) with Equinox (18,500 on 09-03, 10-03, 11-03) and the emergency-fund savings at bank 1 and Netflix (1,549 on 09-10, 10-10, 11-10) at bank 2; detection and the month's check-in have run. `DELETE /sync/items/{bank 1}`, then the worker | Only the bank 2 card remains, with its 3 transactions; no snapshots or holdings; the goal's `account_id` is null; `recurring_charges` holds only `netflix.com`; the Equinox `recurring_new` and the `goal_off_pace` findings are gone; Netflix's finding, the election mismatch and the three deduction changes stay |
| 11 | `test_a_handled_finding_about_the_item_is_kept_as_history` | Example 10 with the Equinox finding dismissed before the unlink | The Equinox finding stays |
| 12 | `test_a_sync_queued_for_the_item_finds_it_missing` | Example 10 with a `sync.incremental` queued for bank 1 before the unlink; the worker has no provider | The job succeeds with outcome `item_missing` |
| 13 | `test_unlink_removes_the_item_at_plaid_with_no_transaction_open` | An item with a token | Plaid's `item_remove` gets the token while no session is open; the row is gone |
| 14 | `test_unlink_without_plaid_configured_still_deletes` | Plaid is not configured | 204; the row is gone |

Example 1 is the completeness check: the test lists the tables from `information_schema.columns` (`table_schema = 'public'`, `column_name = 'user_id'`, base tables only) and first asserts that A has a row in each, so a table added later without a row in the fixture fails the test instead of passing unchecked.

## Edge cases

- A user with no linked institution: step (b) does nothing.
- A CSV item (`access_token_enc` null) is not sent to Plaid; it goes with the cascade.
- Plaid answers `ITEM_NOT_FOUND` (already removed): logged like any other Plaid error.
- The token key was rotated and an old token no longer decrypts: logged, the item is still deleted.
- A webhook for one of the user's items arriving after the delete finds no item and queues nothing (spec 002 rule 25).
- Unlinking a CSV item: nothing is sent to Plaid; the rest is the same.
- Unlinking when no check-in is open this month: detection still runs and drops the charges; no refresh is queued, and earlier months' check-ins are history and are not edited.

## Out of scope

- A grace period or undo. Deletion is immediate and final.
- Exporting the user's data before deletion (the plan PDF and calendar file already exist).
- Keeping `llm_calls` for cost reporting after the account is gone (spec 001 rule 27 keeps them while it exists): they go with the cascade like every other user row.
