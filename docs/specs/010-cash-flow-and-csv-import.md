# 010: Cash flow and CSV import

Status: Implemented, M5. Settles spec 001 open question 5 (CSV transaction ids). Rule 15a (`added` and `already_present` in place of `imported`) added for issue 231; rule 17's import targets on Link narrowed to CSV accounts for issue 241. Rules 5b-5d (the diagram's every node and band from the API, and `GET /spending/months`) added on November 9 (issue #236): on the production e2e account's October the diagram drew "Gross pay, 1 stub $2,708.33" about 157 px tall and "Take-home $1,996.04" about 300 px, because the client sized take-home by the $5,234.98 of spending drawn out of it, which the $3,240.12 deposited could not pay for either; the legend listed the pay stub groups in months with no stub, and the picker offered June 2026, a month with no transaction.

## Goal

Part A gives the Spending screen's cash-flow diagram every number it draws, so the client never adds money: `GET /cashflow` returns, for a period, the gross-to-net withholding lines of each confirmed pay stub (stage 1 of the diagram) beside the spending summary of spec 007 part B (stages 2 and 3), and the diagram itself: every node's amount and every band's, so that what flows into a node equals what flows out of it (rule 5b). `GET /spending/months` says which months have anything to show, for the period picker (rule 5d). Code: `api/calc/cashflow.py` (pure), `api/app/routers/cashflow.py`, `api/app/routers/spending.py`.

Part B lets a user bring in an account they will not link through Plaid: `POST /accounts/import` takes a bank's CSV export, converts it to the shared sign convention and writes it through the same `pipeline.run_sync` as a Plaid sync, which then queues categorization and recurring detection. Code: `api/sync/csv_provider.py`, the route in `api/app/routers/accounts.py`.

## Inputs

### `GET /cashflow`

`start` and `end`, inclusive ISO dates, with exactly the rules of `GET /spending/summary` (spec 007 part B): both or neither, `start <= end`, at most 366 days, and the last complete calendar month before the person's today by default (spec 019).

### `GET /spending/months`

No parameters.

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
- `diagram` (`FlowDiagram`, rule 5b): `nodes`, each `{id, kind, key, column, cents, refunds_cents, categories}`, in the order the diagram draws them (column 0 to 3, top to bottom), and `links`, each `{source, target, cents}` with `cents > 0`. Node ids, kinds and columns:

  | `id` | `kind` | `key` | Column | `cents` | When |
  |---|---|---|---|---|---|
  | `gross` | `gross` | null | 0 | `withholding.gross_cents` (0 with no stub) | always |
  | `line:<line key>` | `line` | the line's key | 1 | the line's amount | with a stub, all seven |
  | `take_home` | `take_home` | null | 1 | `withholding.net_cents` | with a stub |
  | `income_deposited` | `income_deposited` | null | 1 | `spending.income_cents` | without a stub |
  | `other_deposits` | `other_deposits` | null | 1 | `income_cents - net_cents` | with a stub, when the deposits are more than take-home |
  | `refunds` | `refunds` | null | 1 | the money in of the essentials, flexible and other categories that net to money in | when one does |
  | `savings_withdrawn` | `savings_withdrawn` | null | 1 | the money in of a savings category that nets to money in | when one does |
  | `beyond_income` | `beyond_income` | null | 1 | `-left_over_cents` | when `left_over_cents < 0` |
  | `not_deposited` | `not_deposited` | null | 2 | `net_cents - income_cents` | with a stub, when take-home is more than the deposits |
  | `bucket:<bucket>` | `bucket` | `essentials`, `flexible`, `savings`, `other` | 2 | the sum of the bucket's categories that net to money out | always, all four |
  | `left_over` | `left_over` | null | 2 | `left_over_cents` | when `left_over_cents >= 0` |
  | `category:<category>` | `category` | the category | 3 | the category's `total_cents` | each category of the four buckets with `total_cents > 0`, grouped by bucket in the buckets' order (so the bands do not cross), each bucket's in `spending.categories` order |

  A bucket node's `refunds_cents` is the money in its categories that net to money in (so the summary's bucket total is `cents - refunds_cents`), null when there is none; every other node's is null. `categories` lists, for `refunds` and `savings_withdrawn`, the categories behind the amount, in `spending.categories` order, and is empty on every other node.

### `GET /spending/months` (`SpendingMonths`)

- `months`: the first day of each calendar month with at least one posted transaction on an active `checking`, `savings` or `credit` account (the rows the summary reads, spec 007 rule 21a) or a current confirmed pay stub paid in it (rule 1), newest first, each once.

### `POST /accounts/import` (`CsvImport`)

200 with `account` (an `AccountOut`, as `GET /accounts` lists it, with the latest balance), `added` (the file's rows the account did not have, now new transactions) and `already_present` (the file's rows the account already had, rule 15a), `categorize_job_id` and `recurring_job_id` (the queued `categorize.run` and `recurring.detect` jobs, for the client to poll).

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

1. **Which stubs.** The user's current confirmed `pay_stubs` with `pay_date` in the period, read under RLS (the same stubs `paycheck_count` counts in spec 007 rule 26). A stub another confirm superseded (spec 005 rules 22a-22d, issue 190) draws nothing, so the same stub confirmed twice is one paycheck, not two.
2. **Lines.** Each stub's seven deduction columns become the seven lines above. Amounts are the stored non-negative magnitudes (spec 001 rule 23).
3. **Per stub.** `deductions_cents` is the sum of the seven lines; `roles` sums the lines by role. `calc/cashflow.py` checks `gross_cents - deductions_cents = net_cents` and raises on a stub that does not balance (the `pay_stub_balances` constraint makes that unreachable for stored rows).
4. **Period totals.** `withholding` sums each line, `gross_cents`, `deductions_cents` and `net_cents` over the period's stubs; with no stubs every amount is 0 and `pay_stubs` is empty.
5. **Spending.** `spending` is computed by the same code as `GET /spending/summary` with the same period; the two routes never disagree. It reads only rows on `checking`, `savings` and `credit` accounts (spec 007 rule 21a): a loan's, investment's or retirement account's own ledger draws no band and is only counted in `ledger_rows_skipped`. Its shares of income are null when there is no income or too little to compare with (spec 007 rule 25), and a bucket's details then say "Too little income to compare" instead of a percentage. Its `income_cents` counts money in only (spec 007 rule 22a), so the diagram's "Income deposited" node is never negative and its "Spent beyond income" node (`-left_over_cents`, a source beside the deposits since rule 5b) appears only when spending really ran past the money that came in. The client draws these amounts as the API gives them (`diagram`, rule 5b); it never adds or flips a sign. Its scale puts the largest node at 240 px, whichever it is: gross pay, the deposits, or a bucket or category when spending outran a small income, as on the sandbox (`web/src/components/sankey/layout.ts:flowScale`). Every column stacks its nodes from the top, so the diagram is as tall as its tallest column (issue 201: the buckets started level with take-home, below seven withholding lines, and the categories level with the first bucket, and with a 400 px target the Acme stub beside the dynamic sandbox's October drew a diagram 1,129 px tall, most of it empty; at 240 px from the top the same month is 707 px).
5a. **Words.** Each label says what its number counts (spec 007 rule 26a). Stage 1 is the period's confirmed pay stubs: the first node reads "Gross pay, 2 stubs", and with no stub paid in the period "No pay stub this period" ($0, dashed), never "No confirmed pay stub", which reads as none at all when the user's stub is from another month; its details say no confirmed stub was paid in the period. Without a stub, stage 2 starts from "Income deposited" (the deposits, `spending.income_cents`) rather than "Take-home" (the stubs' `net_cents`). The columns are headed "Pay stubs, October", "Taken out of pay", "Spent and saved" and "Categories", and what is left is "Left over". With a stub, the card's lead names both sources and the deposits' amount: "Gross pay to take-home comes from 1 pay stub. Spending comes from the $4,050.12 deposited in your accounts, which can include pay with no confirmed stub." (issue 200: the summary's income and the diagram's gross pay read as two incomes); without one, "Spending comes from the $4,050.12 of income deposited in your accounts." with a pointer to confirming a stub. Take-home's details give both figures by name: "Take-home on 1 pay stub" (the stubs' `net_cents`) and "Income deposited in your accounts" (`spending.income_cents`). The diagram (desktop) and the stacked bars (`FlowStack`, under 640 px) take these names from the same layout, and the check-in's cash flow heads its table with the period and its pay stubs ("October 1 to 30 · 1 pay stub").
5b. **The diagram conserves money** (issue #236). Every node's amount is the API's and the client draws each node as tall as its amount (at least tall enough for its words, `MIN_NODE_H`) and each band as thick as its `cents`, so a node is never sized by what flows through it. For every node with bands in, they sum to its `cents`; for every node with bands out, so do they. Stage 1: `gross` flows into each line with a positive amount and into `take_home` (rule 3: `gross = deductions + net`). Stage 2 is where the period's money came from and where it went. The money came in as deposits (`spending.income_cents`), as money back in a spending or savings category (a refund that outweighed the period's purchases in its category, the sale of an investment), and, when spending and saving outran all of that, from money already in the accounts, savings or credit (`beyond_income`, `-left_over_cents`, never a negative node). With a stub the deposits are drawn as `take_home` and, when they are more, `other_deposits` (pay with no confirmed stub, interest, other income); when the deposits are less than take-home, the rest of take-home is `not_deposited` (paid to an account that is not linked, or not deposited yet). The money went to the four buckets, each the sum of its categories that net to money out, and to `left_over`. So the sources, in order `take_home` (or `income_deposited`), `other_deposits`, `refunds`, `savings_withdrawn`, `beyond_income`, sum to the uses, in order `not_deposited`, `bucket:essentials`, `bucket:flexible`, `bucket:savings`, `bucket:other`, `left_over`: with deposits `D`, take-home `N`, money back `R` and the summary's left over `L = D - (P - R)`, where `P` is the buckets' sum, both sides are `max(N, D) + R + max(-L, 0)`. The bands pair them in that order, as two stacks of the same height laid side by side: each band is the overlap of a source's slice with a use's, so take-home pays for `not_deposited` first and the buckets from the top, and the bands never cross. Stage 3: each bucket flows into its categories with `total_cents > 0`. A category that nets to money in is not drawn as a category (a node cannot be negative); it is part of `refunds` or `savings_withdrawn`, and its bucket's node is the bucket's spending before that money back, with `refunds_cents` saying how much the summary nets out. Uncategorized rows are in no node, as they are in no bucket (spec 007 rule 23).
5c. **The client only draws.** `web/src/components/sankey/layout.ts` takes `diagram` as it comes: nodes in their columns and order, heights from one scale (`TARGET_GROSS_PX` for the largest node, so "1 px is about $N" follows; no scale when every node is zero), bands stacked along each node in the order of `links`. It hides a zero line other than the 401(k) ("401(k), not elected", dashed) and a zero `bucket:other`, and draws any other zero node dashed. Its words: `take_home` "Take-home", `income_deposited` "Income deposited", `other_deposits` "Other deposits", `refunds` "Refunds", `savings_withdrawn` "Taken out of savings", `beyond_income` "Spent beyond income", `not_deposited` "Not deposited", buckets by name and "Left over". The legend lists only the groups drawn as nodes with an amount (`legendFor`), so a period with no stub lists no pay stub group.
5d. **Months with something to show.** The period picker (`web/src/lib/periods.ts`) offers this month so far, the last complete month and the four before it, each only when `GET /spending/months` lists it; until the months arrive it waits, and if they cannot be read it offers all six. The period the summary shows is always offered.
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

15a. **Added and already there** (issue 231). Every data row of a valid file is either `added` (no transaction of the target account has its `provider_txn_id`, so the import makes one) or `already_present` (one has: an earlier import of the same rows, rule 15, which this import leaves as it was), so `added + already_present` is the file's row count. The route counts them before the write, inside the import's transaction, from the account's own ids; a new account has none. Before issue 231 the response had one count, `imported`, of every row written, new or not, so importing the same file twice said "Imported 5 transactions" both times though the second import added none. The Link screen says both: "Added 5 transactions to E2E CSV Checking.", "Added 1 transaction to E2E CSV Checking. 4 were already there.", or "No new transactions: all 5 were already in E2E CSV Checking."

### Part B: the import

16. The route parses and validates the whole file before touching the database.
17. **Target account.** Without `account_id`, the import creates a `sync_items` row (`provider = 'csv'`, no `provider_item_id`, no access token) and, through the pipeline, one account with `provider_account_id = 'csv'`, the given `kind` and `name`. With `account_id`, the account must be visible to the user (else 404) and belong to a CSV item (else 422 `not_csv_account`); its name and kind are kept. The Link screen's "Import into" list therefore offers only CSV accounts (`provider = 'csv'`) besides "A new account": a linked bank's accounts, loans among them, fill from the bank, and the API would refuse them (issue 241; before it every account was listed).
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
| 5 | `test_loan_ledgers_draw_no_band` | Spec 007's loan ledger month (rule 21a), no confirmed stub | `spending` equal to `GET /spending/summary` for September: `income_cents` 250,000, `other_cents` 40,000, `left_over_cents` 70,000, `ledger_rows_skipped` count 3, net -38,000 |

### The diagram (`api/tests/unit/calc/test_cashflow.py`, rule 5b)

Amounts in cents. Links are written `source -> target cents`.

| # | Test | Input | Nodes beyond the buckets | Links |
|---|---|---|---|---|
| D1 | `test_spending_beyond_take_home_and_deposits` | Issue #236: one stub (example 2's mockup stub: gross 270,833, net 199,604); deposits 324,012; housing 250,000, groceries 60,000, dining 80,000, shopping 131,344, savings_investment 2,154 (essentials 310,000, flexible 211,344, savings 2,154, other 0, left over -199,486) | `take_home` 199,604, `other_deposits` 124,408, `beyond_income` 199,486; `left_over` absent | `take_home -> bucket:essentials` 199,604; `other_deposits -> bucket:essentials` 110,396; `other_deposits -> bucket:flexible` 14,012; `beyond_income -> bucket:flexible` 197,332; `beyond_income -> bucket:savings` 2,154; then each bucket to its categories |
| D2 | `test_take_home_equal_to_deposits` | Spec 007's September (two mockup stubs, net 399,208; deposits 399,208; housing 150,000, groceries 30,000, dining 8,500, savings_investment 40,000, fees 3,900; left over 166,808) | `take_home` 399,208; `left_over` 166,808 | `take_home ->` essentials 180,000, flexible 8,500, savings 40,000, other 3,900, `left_over` 166,808 |
| D3 | `test_a_refund_is_money_in` | The Plaid sandbox's October, no stub (example 4): deposits 422; dining 51,633, transport 540, shopping 58,940, entertainment 7,850, travel -50,000, savings_investment 100,000; left over -168,541 | `income_deposited` 422, `refunds` 50,000 (categories `travel`), `beyond_income` 168,541; `bucket:flexible` 118,423 with `refunds_cents` 50,000; no `category:travel` | `income_deposited -> bucket:essentials` 422; `refunds -> bucket:essentials` 118; `refunds -> bucket:flexible` 49,882; `beyond_income -> bucket:flexible` 68,541; `beyond_income -> bucket:savings` 100,000 |
| D4 | `test_take_home_not_deposited` | One mockup stub (net 199,604); deposits 150,000; housing 100,000; left over 50,000 | `take_home` 199,604, `not_deposited` 49,604, `left_over` 50,000 | `take_home -> not_deposited` 49,604; `take_home -> bucket:essentials` 100,000; `take_home -> left_over` 50,000 |
| D5 | `test_money_taken_out_of_savings` | No stub; deposits 300,000; housing 150,000; savings_investment -50,000; left over 200,000 | `income_deposited` 300,000, `savings_withdrawn` 50,000 (categories `savings_investment`); `bucket:savings` 0 with `refunds_cents` 50,000; `left_over` 200,000 | `income_deposited -> bucket:essentials` 150,000; `income_deposited -> left_over` 150,000; `savings_withdrawn -> left_over` 50,000 |
| D6 | `test_an_empty_period` | No stub, no transactions | `gross` 0, `income_deposited` 0, the four buckets 0, `left_over` 0 | none |
| D7 | `test_cash_withdrawn_is_drawn_as_spending` | Issue #250, spec 007's cash example: no stub; deposits 200,000; housing 100,000, dining 2,500, cash 6,000, transfer 20,000 (essentials 100,000, flexible 8,500, left over 91,500) | `income_deposited` 200,000; `category:cash` 6,000 under `bucket:flexible` 8,500; no node for the transfer; `left_over` 91,500 | `income_deposited ->` essentials 100,000, flexible 8,500, `left_over` 91,500; `bucket:flexible ->` `category:dining` 2,500, `category:cash` 6,000 |

Working: D1, the sources stack `take_home` [0, 199,604), `other_deposits` [199,604, 324,012), `beyond_income` [324,012, 523,498); the uses stack essentials [0, 310,000), flexible [310,000, 521,344), savings [521,344, 523,498). Each band is an overlap: `other_deposits` meets essentials over [199,604, 310,000), 110,396, and flexible over [310,000, 324,012), 14,012; `beyond_income` meets flexible over [324,012, 521,344), 197,332, and savings, 2,154; flexible gets `14,012 + 197,332 = 211,344`. Both stacks are 523,498: `max(199,604, 324,012) + 0 + 199,486`. D3: flexible's positive categories are `51,633 + 58,940 + 7,850 = 118,423`, the summary's 68,423 plus the 50,000 refund; the sources are `422 + 50,000 + 168,541 = 218,963 = 540 + 118,423 + 100,000`. D4: `max(199,604, 150,000) = 199,604 = 49,604 + 100,000 + 50,000`. D5: `300,000 + 50,000 = 150,000 + 0 + 200,000`. D7: `200,000 = 100,000 + 8,500 + 91,500`; the cash taken out is spending (spec 003 rule 9d), so it is a band like dining's, while the 20,000 moved to savings is in no node (spec 007 rule 23).

### Months (`api/tests/integration/test_cashflow.py`, rule 5d)

| # | Test | Setup | Expected |
|---|---|---|---|
| M1 | `test_months_with_something_to_show` | Posted rows on a checking account on 2026-07-14 and 2026-09-02, a pending row on 2026-06-30, a row on a loan account on 2026-05-05, a confirmed stub paid 2026-10-15, and user B's row on 2026-04-01 | `months` = 2026-10-01, 2026-09-01, 2026-07-01 |

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
| 1 | `test_import_creates_an_account` | File A, `kind = checking`, `name = Credit union` | 200, `added = 3`, `already_present = 0`; `GET /accounts` shows "Credit union", checking, balance 297605; three transactions with the signs of parsing example 1; both job ids are queued jobs of those kinds |
| 2 | `test_reimport_is_idempotent` | File A, then File A again with `account_id` | Still three transactions, one account, one CSV item; the second import says `added = 0`, `already_present = 3` |
| 3 | `test_overlap_adds_only_new_rows` | File A, then a file with A's 2026-10-03 row and a 2026-10-04 row | Four transactions; the second import says `added = 1`, `already_present = 1` |
| 4 | `test_invalid_file_writes_nothing` | Parsing example 4's file | 422 `csv_invalid` with three errors; no sync item, account or job |
| 5 | `test_plaid_account_is_refused` | `account_id` of a Plaid account | 422 `not_csv_account` |
| 6 | `test_inconsistent_fields` | `account_id` with `kind`; neither | 422 each |
| 7 | `test_too_large_is_413` | A body over 10 MB | 413 `file_too_large` |

## Edge cases

- A period with stubs but no transactions has withholding lines and an all-zero `spending`, and its diagram sends all of take-home to `not_deposited`; one with transactions but no stubs has zero withholding and `paycheck_count = 0`.
- A bucket whose categories all net to money in is a zero node; its money in is a source (`refunds`, or `savings_withdrawn` for savings).
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
