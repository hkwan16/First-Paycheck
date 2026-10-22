# 010: Cash flow and CSV import

Status: Implemented, M5. Settles spec 001 open question 5 (CSV transaction ids).

## Goal

Part A gives the Spending screen's cash-flow diagram every number it draws, so the client never adds money: `GET /cashflow` returns, for a period, the gross-to-net withholding lines of each confirmed pay stub (stage 1 of the diagram) beside the spending summary of spec 007 part B (stages 2 and 3). Code: `api/calc/cashflow.py` (pure), `api/app/routers/cashflow.py`.

Part B lets a user bring in an account they will not link through Plaid: `POST /accounts/import` takes a bank's CSV export, converts it to the shared sign convention and writes it through the same `pipeline.run_sync` as a Plaid sync, which then queues categorization and recurring detection. Code: `api/sync/csv_provider.py`, the route in `api/app/routers/accounts.py`.

## Inputs

### `GET /cashflow`

`start` and `end`, inclusive ISO dates, with exactly the rules of `GET /spending/summary` (spec 007 part B): both or neither, `start <= end`, at most 366 days, and the last complete UTC calendar month by default.

### `POST /accounts/import` (multipart form)

| Field | Type | Meaning and validation |
|---|---|---|
| `file` | CSV file | At most 10 MB; UTF-8, with or without a byte-order mark; at most 50,000 data rows |
| `account_id` | uuid, optional | An existing CSV account of the user to add to |
| `kind` | `account_kind` | Required without `account_id`, refused with it |
| `name` | string, optional | 1-100 characters after trimming; only without `account_id`; default `"<Kind> (CSV)"`, for example `"Checking (CSV)"` |
| `institution_name` | string, optional | 1-200 characters; only without `account_id` |
| `sign` | `negative_is_out` (default) or `positive_is_out` | How the file's `amount` column is signed; ignored for debit and credit columns |

**Columns.** The first row is a header. Names are matched after trimming and lowercasing; unknown columns are ignored.

| Column | Accepted names | Required |
|---|---|---|
| date | `date`, `posted date`, `posting date`, `transaction date` | Yes |
| description | `description`, `name`, `payee`, `merchant` | Yes |
| amount | `amount` | Either `amount`, or both `debit` and `credit` |
| debit | `debit`, `withdrawal` | |
| credit | `credit`, `deposit` | |
| balance | `balance`, `running balance` | No |

## Outputs

### `GET /cashflow` (`CashFlow`)

- `start`, `end`.
- `pay_stubs`: one `PayStubFlow` per confirmed pay stub with `pay_date` in the period, ordered by `pay_date`, then `id`: `pay_stub_id`, `pay_date`, `gross_cents`, `lines`, `roles`, `deductions_cents`, `net_cents`.
- `withholding`: a `WithholdingFlow` summing every stub in the period, with the same `gross_cents`, `lines`, `roles`, `deductions_cents` and `net_cents`, plus `paycheck_count`.
- `lines`: always the seven `WithholdingLine` items below, in this order, zero when absent: `key`, `label`, `role`, `amount_cents`.

  | `key` | `label` | `role` |
  |---|---|---|
  | `federal_withholding` | Federal tax | `tax` |
  | `social_security` | Social Security | `tax` |
  | `medicare` | Medicare | `tax` |
  | `state_tax` | State tax | `tax` |
  | `retirement_contribution` | 401(k) | `retirement` |
  | `medical_premium` | Health premiums | `health` |
  | `other_deductions` | Other deductions | `other` |

- `roles`: `tax_cents`, `retirement_cents`, `health_cents`, `other_cents`, the sum of the lines of each role.
- `spending`: the `SpendingSummary` that `GET /spending/summary` returns for the same period (spec 007 part B), so stage 2 (take-home to buckets and what is left over) and stage 3 (buckets to categories) come from one place.

### `POST /accounts/import` (`CsvImport`)

200 with `account` (an `AccountOut`, as `GET /accounts` lists it, with the latest balance), `imported` (data rows written, new or updated), `categorize_job_id` and `recurring_job_id` (the queued `categorize.run` and `recurring.detect` jobs, for the client to poll).

| Status | Code | When |
|---|---|---|
| 404 | `not_found` | `account_id` is not one of the user's accounts |
| 409 | `import_conflict` | Another import into the same account committed first (rule 21) |
| 413 | `file_too_large` | Over 10 MB |
| 422 | `csv_invalid` | The file breaks a rule below; `details.errors` lists `{row, column, message}` |
| 422 | `not_csv_account` | `account_id` belongs to a Plaid account |
| 422 | `validation_error` | The form fields are inconsistent (for example `account_id` with `kind`) |

## Rules

### Part A: cash flow

1. **Which stubs.** The user's confirmed `pay_stubs` with `pay_date` in the period, read under RLS (the same stubs `paycheck_count` counts in spec 007 rule 26).
2. **Lines.** Each stub's seven deduction columns become the seven lines above. Amounts are the stored non-negative magnitudes (spec 001 rule 23).
3. **Per stub.** `deductions_cents` is the sum of the seven lines; `roles` sums the lines by role. `calc/cashflow.py` checks `gross_cents - deductions_cents = net_cents` and raises on a stub that does not balance (the `pay_stub_balances` constraint makes that unreachable for stored rows).
4. **Period totals.** `withholding` sums each line, `gross_cents`, `deductions_cents` and `net_cents` over the period's stubs; with no stubs every amount is 0 and `pay_stubs` is empty.
5. **Spending.** `spending` is computed by the same code as `GET /spending/summary` with the same period; the two routes never disagree. Its `income_cents` counts money in only (spec 007 rule 22a), so the diagram's "Income deposited" node is never negative and its "Spent beyond income" node (a negative `left_over_cents`) appears only when spending really ran past the money that came in. The client draws these amounts as the API gives them; it never adds or flips a sign. Its scale puts the tallest node at 400 px: gross pay (or income without a stub), or a bucket or category when spending outran a small income, as on the sandbox (`web/src/components/sankey/layout.ts:flowScale`).
6. All arithmetic is in `calc/cashflow.py`: pure, integer cents, no I/O. The route reads rows and maps ids and dates.

### Part B: parsing the file (`sync/csv_provider.py`)

7. **Rows.** Row numbers count the header as row 1, so they match a spreadsheet's row numbers. Rows whose cells are all blank are skipped. A file with no data rows is `csv_invalid`.
8. **Header.** It must name a date column, a description column, and either an amount column or both a debit and a credit column (not both forms). Two columns that map to the same role are an error. Header errors are reported on row 1 and stop the check there.
9. **Date.** `YYYY-MM-DD` or `MM/DD/YYYY` (one or two digit month and day), a real calendar date. Day-first dates are not accepted, because `03/04/2026` would be ambiguous.
10. **Description.** Non-empty after trimming, at most 500 characters. It becomes `merchant_raw`; `merchant_clean` is null and `merchant_norm` is `normalize_merchant(merchant_raw)` (spec 003).
11. **Money.** An optional `+` or `-`, an optional `$`, digits with optional thousands commas, and at most two decimal places; or the same wrapped in parentheses for a negative amount. Spaces around the value are ignored. Accepted: `12`, `-12.5`, `$1,234.56`, `(45.00)`, `+3.10`. Rejected: `12.345`, `1,23`, `12-`, `abc`. The value converts to cents exactly; nothing is rounded.
12. **Sign** (spec 001 rule 21, amendment 7: positive is money out). With an amount column and `sign = negative_is_out` (how most banks export), `amount_cents = -cents(amount)`; with `positive_is_out`, `amount_cents = cents(amount)`. With debit and credit columns exactly one of the two must be filled per row, as a non-negative value: a debit is money out (`+cents`), a credit is money in (`-cents`).
13. **Balance.** When a balance column exists, the account's balance is the one written on the newest row that has one: the latest date, and among rows of that date, the one nearest the end of the file when the file runs oldest first (its first data row's date is not later than its last), otherwise nearest the start. It is stored as written; for a credit or loan account it must be the amount owed. Without a balance column the import writes no balance snapshot.
14. **Errors.** Every row is checked; the first 50 errors are returned in file order as `{row, column, message}` (`column` is the role, such as `date`, or null for the whole file), and the message counts all of them. Nothing is written when there is any error.
15. **Transaction ids** (settles spec 001 open question 5). `provider_txn_id = "csv-" + sha256("<date>|<amount_cents>|<description>|<n>")[:32]` in hex, where `n` is the row's occurrence number (1, 2, ...) among rows of the file with the same date, signed amount and trimmed description. Re-importing a file, or an overlapping export that covers whole days, writes no duplicates; two identical purchases on one day stay two transactions.

### Part B: the import

16. The route parses and validates the whole file before touching the database.
17. **Target account.** Without `account_id`, the import creates a `sync_items` row (`provider = 'csv'`, no `provider_item_id`, no access token) and, through the pipeline, one account with `provider_account_id = 'csv'`, the given `kind` and `name`. With `account_id`, the account must be visible to the user (else 404) and belong to a CSV item (else 422 `not_csv_account`); its name and kind are kept.
18. **One pipeline.** The import is `pipeline.run_sync` (spec 002 rules 10-16) with `CsvProvider`: one account, one page with every row in `added` (no `modified` or `removed`), `has_more = false`, `next_cursor = "csv-" + sha256(file bytes)` in hex, the balance of rule 13, no holdings. Upserts, the balance snapshot, the cursor and the follow-up `categorize.run` and `recurring.detect` jobs are the pipeline's.
19. **One transaction.** Unlike a Plaid sync, the CSV provider makes no network call, so the whole import (the new item, the pipeline's reads and writes, the queued jobs) runs in the request's single user session and commits once: a failure leaves nothing behind.
20. The response's job ids are the queued `categorize.run` and `recurring.detect` jobs (`enqueue_unless_queued` returns the pipeline's).
21. **Concurrency.** Two imports into the same account serialize on the pipeline's `SELECT ... FOR UPDATE` of the item; the second sees a different cursor, the pipeline reports `stale`, and the route answers 409 `import_conflict`, writing nothing.
22. **Size.** The 10 MB limit is enforced from `Content-Length` by the body-size middleware (`app/body_limit.py`) before the body is read, and again by the route on the bytes received.
23. Transactions an earlier import wrote are never deleted by a later one; a CSV import only adds and updates. Removing them means unlinking the CSV item (`DELETE /sync/items/{id}`, spec 002 rule 28).

## Hand-worked examples

### Withholding (`api/tests/unit/calc/test_cashflow.py`)

| # | Test | Input | Expected |
|---|---|---|---|
| 1 | `test_one_stub_lines` | gross 270,833; federal 28,476; Social Security 16,792; Medicare 3,927; state 9,814; 401(k) 10,833; medical 6,250; other 4,670; net 190,071 | roles tax 59,009, retirement 10,833, health 6,250, other 4,670; deductions 80,762; net 190,071 |
| 2 | `test_two_mockup_stubs_sum` | The Confirm mockup stub (spec 005 example 1) twice | gross 541,666; federal 59,552; Social Security 33,584; Medicare 7,854; state 19,628; 401(k) 0; medical 12,500; other 9,340; tax 120,618; deductions 142,458; net 399,208 |
| 3 | `test_no_stubs_is_all_zero` | No stubs | Every amount 0, seven zero lines, `paycheck_count = 0` |
| 4 | `test_unbalanced_stub_raises` | Example 1 with net 190,072 | `ValueError` |

Working:

- Row 1: tax `28,476 + 16,792 + 3,927 + 9,814 = 59,009`; deductions `59,009 + 10,833 + 6,250 + 4,670 = 80,762`; `270,833 - 80,762 = 190,071`, which equals net. (10,833 is 4% of 270,833, 10,833.32, rounded half up.)
- Row 2: one mockup stub is gross 270,833 with federal 29,776, Social Security 16,792, Medicare 3,927, state 9,814, 401(k) 0, medical 6,250, other 4,670 and net 199,604 (`270,833 - 71,229 = 199,604`). Doubled: tax `59,552 + 33,584 + 7,854 + 19,628 = 120,618`; deductions `120,618 + 0 + 12,500 + 9,340 = 142,458`; `541,666 - 142,458 = 399,208`, twice 199,604.

### Cash flow route (`api/tests/integration/test_cashflow.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_september_cash_flow` | Spec 007 part B's September transactions and two mockup stubs paid 2026-09-15 and 2026-09-30 | `pay_stubs` in date order, each net 199,604; `withholding` as example 2 with `paycheck_count = 2`; `spending` equal to `GET /spending/summary?start=2026-09-01&end=2026-09-30` (income 399,208, left over 166,808) |
| 2 | `test_default_period_is_last_month` | Today 2026-10-21 | `start = 2026-09-01`, `end = 2026-09-30` |
| 3 | `test_period_validation` | `start` alone; `start > end`; 367 days | 422 each |
| 4 | `test_sandbox_income_is_never_negative` | The Plaid sandbox's October (spec 007 part B), no confirmed stub | `spending` equal to `GET /spending/summary` for October: `income_cents` 422 (the GUSTO PAY outflow in `income_outflows_ignored_cents` 585,000), `left_over_cents` -168,541 |

### Parsing (`api/tests/unit/sync/test_csv_provider.py`)

File A:

```
Date,Description,Amount,Balance
2026-10-01,NETFLIX.COM,-15.49,984.51
10/02/2026,ACME PAYROLL,"1,996.04","2,980.55"
2026-10-03,BLUE BOTTLE COFFEE,(4.50),2976.05
```

| # | Test | Input | Expected |
|---|---|---|---|
| 1 | `test_amount_column_bank_convention` | File A | `amount_cents` 1549, -199604, 450; dates 2026-10-01, 10-02, 10-03; balance 297605 |
| 2 | `test_positive_is_out_option` | File A, `sign = positive_is_out` | -1549, 199604, -450 |
| 3 | `test_debit_and_credit_columns` | `Posted Date,Payee,Debit,Credit` with `2026-10-01,NETFLIX.COM,15.49,` and `2026-10-02,ACME PAYROLL,,1996.04` | 1549, -199604; no balance |
| 4 | `test_row_errors_are_numbered` | File A's header and first row, then `2026-13-01,BAD DATE,-1.00`, `2026-10-03,,-2.00`, `2026-10-04,TOO PRECISE,-1.005` | Errors on row 3 `date`, row 4 `description`, row 5 `amount` |
| 5 | `test_missing_columns` | Header `When,What,HowMuch` | Row 1 errors for `date`, `description` and `amount` |
| 6 | `test_identical_rows_get_distinct_stable_ids` | Two rows `2026-10-01,COFFEE,-4.50` | Two different ids; parsing again gives the same two |
| 7 | `test_debit_and_credit_both_filled` | `2026-10-01,X,1.00,2.00` | Row 2 error |
| 8 | `test_newest_first_balance` | File A's rows in reverse order | Balance 297605 (from the first data row) |

Working for row 1: under `negative_is_out`, `-15.49` is 1549 cents out; `1,996.04` is 199604 cents in, so -199604; `(4.50)` is -4.50, so 450 out. File A runs oldest first (2026-10-01 is not later than 2026-10-03), so the balance comes from the last row with the latest date, `2976.05`. The running balance checks out: `984.51 + 1,996.04 - 4.50 = 2,976.05`.

### Import route (`api/tests/integration/test_csv_import.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_import_creates_an_account` | File A, `kind = checking`, `name = Credit union` | 200, `imported = 3`; `GET /accounts` shows "Credit union", checking, balance 297605; three transactions with the signs of parsing example 1; both job ids are queued jobs of those kinds |
| 2 | `test_reimport_is_idempotent` | File A, then File A again with `account_id` | Still three transactions, one account, one CSV item |
| 3 | `test_overlap_adds_only_new_rows` | File A, then a file with A's 2026-10-03 row and a 2026-10-04 row | Four transactions |
| 4 | `test_invalid_file_writes_nothing` | Parsing example 4's file | 422 `csv_invalid` with three errors; no sync item, account or job |
| 5 | `test_plaid_account_is_refused` | `account_id` of a Plaid account | 422 `not_csv_account` |
| 6 | `test_inconsistent_fields` | `account_id` with `kind`; neither | 422 each |
| 7 | `test_too_large_is_413` | A body over 10 MB | 413 `file_too_large` |

## Edge cases

- A period with stubs but no transactions has withholding lines and an all-zero `spending`; one with transactions but no stubs has zero withholding and `paycheck_count = 0`.
- A stub paid on `end` is included; one paid the day after is not.
- A CSV whose `amount` cells are all positive is still read under the `sign` option; the client asks the user which way their bank signs amounts when the preview looks wrong.
- A CSV row with a zero amount is imported (some banks list zero-dollar authorizations).
- A row with a date in the future is imported as written.
- A file with only a header is `csv_invalid` (no data rows).

## Out of scope

- The plan's targets beside each bucket (goals arrive in M6) and net worth.
- Other file formats (OFX, QFX, Excel), day-first dates, other currencies, and remembering a bank's column layout.
- Deleting individual imported transactions, or an import that replaces earlier rows.
- Rate limiting imports (uploads are limited per spec 004; imports may join that limit later).
