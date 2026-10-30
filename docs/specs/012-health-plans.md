# 012: Health plan comparison calculator

Status: Implemented, M6. Every example is a test; the 2026 HSA and HDHP constants were verified against Rev. Proc. 2025-19 on 2026-10-21. Rule 17 (a negative net cost reads as coming out ahead) added 2026-10-30, issue 154.

## Goal

Compare the health plans an employer offers on what each one would cost the user in a year: premiums, plus what they pay for care at low, medium and high usage, minus the employer's HSA contribution and the federal income tax an HSA contribution saves. Show, for each pair of plans, the annual medical spending at which the cheaper plan changes, and recommend the cheapest plan at the user's expected usage. The calculator is a pure function in `api/calc/health_plans.py`, served by `POST /calc/health-plans`; it saves nothing. `POST /decisions` with `calculator = health_plans` saves the plan the user picks and, when the input carries an enrollment deadline, adds it to the calendar.

## Inputs

| Field | Type | Meaning and validation |
|---|---|---|
| `plans` | list of `HealthPlanOption`, 1 to 8 | The options, usually the user's confirmed `benefits_plans` (spec 013). |
| `plans[].name` | text | 1 to 200 characters. |
| `plans[].kind` | `hdhp`, `ppo`, `hmo` | `hdhp` is a high-deductible plan that may pair with an HSA. |
| `plans[].premium_per_period_cents` | `Cents` | What the employee pays per paycheck for employee-only coverage. |
| `plans[].deductible_cents` | `Cents` | In-network, employee-only. Must not exceed `oop_max_cents`. |
| `plans[].coinsurance_pct` | `Percent` | The member's share after the deductible, 0 to 100. |
| `plans[].oop_max_cents` | `Cents` | In-network, employee-only out-of-pocket maximum. |
| `plans[].employer_hsa_cents` | `Cents` | The employer's annual HSA contribution. Must be 0 unless `kind = hdhp`. |
| `pay_periods_per_year` | int | 12, 24, 26 or 52. |
| `salary_cents` | `PositiveCents` | Annual salary, for the marginal rate. |
| `filing_status` | enum | `single`, `married_filing_jointly`, `head_of_household`. |
| `tax_year` | int | Must have `api/calc/data/<tax_year>.json`, else 422. |
| `employee_hsa_cents` | `Cents` | What the user plans to put into the HSA themselves in the year, if they choose an HSA-eligible plan. |
| `expected_usage` | `low`, `medium`, `high` | The profile's `expected_healthcare_usage`. |
| `usage_low_cents`, `usage_medium_cents`, `usage_high_cents` | `Cents` | Annual in-network medical spending (allowed amounts, before the plan pays) for each scenario. Defaults 50,000 ($500), 300,000 ($3,000) and 1,000,000 ($10,000); must be strictly ascending. |
| `selected_plan_index` | int or null | The plan the user picks (an index into `plans`). Optional for the calculator; `POST /decisions` requires it (rule 14). |
| `enrollment_deadline` | date or null | The last day to enroll, from the benefits summary. Only `POST /decisions` uses it (rule 15). |

## Outputs

| Field | Type | Meaning |
|---|---|---|
| `marginal_rate_used` | Decimal | Federal bracket rate, in percent points, at `salary - standard deduction`. |
| `hsa_limit_cents` | `Cents` | The self-only HSA contribution limit for `tax_year`. |
| `hdhp_min_deductible_cents`, `hdhp_max_oop_cents` | `Cents` | The self-only HDHP thresholds for `tax_year`. |
| `plans` | list of `PlanCost` | One per input plan, in input order. |
| `plans[].name`, `plans[].kind` | | As given. |
| `plans[].annual_premium_cents` | `Cents` | `premium_per_period_cents * P`. |
| `plans[].hsa_eligible` | bool | Rule 3. |
| `plans[].employer_hsa_cents` | `Cents` | As given. |
| `plans[].employee_hsa_cents` | `Cents` | The user's own contribution the plan allows (rule 4). |
| `plans[].hsa_capped` | bool | True when `employee_hsa_cents` was cut to the limit. |
| `plans[].hsa_tax_savings_cents` | `Cents` | Federal income tax that contribution saves (rule 5). |
| `plans[].low_cost_cents`, `medium_cost_cents`, `high_cost_cents` | `SignedCents` | Expected annual net cost at each scenario (rule 7). Can be negative; shown as an amount ahead (rule 17). |
| `plans[].worst_case_cents` | `SignedCents` | Net cost when spending reaches the out-of-pocket maximum. Can be negative too (rule 17). |
| `pairs` | list of `PlanPair` | One per pair `i < j`, in order `(0,1), (0,2), ..., (1,2), ...`. |
| `pairs[].plan_a_index`, `plan_b_index` | int | The pair. |
| `pairs[].cheaper_at_zero_index` | int or null | The plan cheaper with no medical spending; null on a tie. |
| `pairs[].break_even_spends_cents` | list of `Cents` | Every scanned spend at which the cheaper plan changes (rule 9), ascending. |
| `pairs[].cheaper_at_end_index` | int or null | The plan cheaper at the end of the scan, where every plan has reached its out-of-pocket maximum; null on a tie. |
| `recommended_index` | int | The cheapest plan at `expected_usage` (rule 10). |
| `selected_index` | int or null | `selected_plan_index`, echoed. |
| `scan_step_cents` | `Cents` | Always 10,000 ($100). |
| `scan_end_cents` | `Cents` | The last spend scanned (rule 8). |
| `citation_keys` | list of str | Rule 11. |

## Rules

Notation: `P` pay periods, `S` salary, for plan `k`: `prem_k`, `D_k`, `c_k`, `M_k` (out-of-pocket maximum), `H_k` (employer HSA). Intermediate values are exact `Decimal`; every output is rounded once, half up, to whole cents.

1. **Constants.** `api/calc/data/<tax_year>.json` holds `hsa`: the self-only and family contribution limits and HDHP minimum deductibles and maximum out-of-pocket amounts, with the source. Only the self-only figures are used.
2. **Marginal rate.** `T = S - standard_deduction(tax_year, filing_status)`; the rate is 0 when `T <= 0`, else the rate of the bracket holding `T` with "not over" bounds (spec 006 rule 9). The HSA contribution is not subtracted first, so one rate serves every plan.
3. **HSA eligibility.** A plan is `hsa_eligible` when `kind = hdhp`, `D_k >= hdhp_min_deductible` and `M_k <= hdhp_max_oop` (Rev. Proc. 2025-19 section 2.01(2) for 2026). A plan labeled `hdhp` that misses either threshold is not eligible: the employee contributes nothing through it, but the employer amount it states still counts (rule 7), because the summary promised it.
4. **Employee HSA.** For an eligible plan `employee_hsa_cents = min(employee_hsa, max(0, hsa_limit - H_k))`, since the employer's contribution counts toward the same limit; `hsa_capped` is true when that is less than requested. For any other plan both are 0 and false.
5. **Tax savings.** `tax_k = employee_hsa_cents * rate / 100` (exact); `hsa_tax_savings_cents = round(tax_k)`. Only federal income tax is modeled, as in spec 006.
6. **Out of pocket.** For annual spending `x`: `OOP_k(x) = x` when `x <= D_k`, else `D_k + (x - D_k) * c_k / 100`, capped at `M_k`.
7. **Net cost.** `cost_k(x) = prem_k * P + OOP_k(x) - H_k - tax_k`, exact. `low_cost_cents = round(cost_k(usage_low))`, and likewise medium and high. `worst_case_cents = round(prem_k * P + M_k - H_k - tax_k)`. Because each output is rounded once from exact values, `low_cost_cents` can differ by a cent from the sum of the rounded parts (example 5).
8. **Scan range.** Plan `k` stops paying more at `cap_k = D_k` when `c_k = 0`, else `D_k + (M_k - D_k) * 100 / c_k`. `scan_end_cents` is the largest `cap_k` rounded up to a multiple of 10,000, but at most 100,000,000 ($1,000,000 of spending). Every pair is scanned over the same points `x = 0, 10,000, 20,000, ..., scan_end_cents`.
9. **Break-even.** For a pair `(a, b)`, `w(x)` is `a` when `cost_a(x) < cost_b(x)`, `b` when greater, and a tie otherwise (exact comparison). `cheaper_at_zero_index = w(0)`, `cheaper_at_end_index = w(scan_end_cents)` (null for a tie), and `break_even_spends_cents` lists every scanned `x > 0` where `w(x)` differs from `w` at the previous step. A spend where the two plans tie exactly therefore appears, followed by the next step where one pulls ahead (example 2). Costs are piecewise linear, so a pair can cross twice: a plan with lower premiums can lose to a richer plan at moderate spending and win again once it has hit its out-of-pocket maximum (example 1).
10. **Recommendation.** `recommended_index` is the plan with the lowest exact cost at the scenario named by `expected_usage`; ties go to the lowest index.
11. **Citations.** `citation_keys` is `health.hdhp_definition`, `health.hsa_limit`, `health.federal_brackets` when any plan has `kind = hdhp`, and `health.federal_brackets` alone otherwise. The passages are in `api/db/seed/irs_citations/health_plans.yaml`.
12. **Purity and validation.** As spec 006 rules 12 and 13. `selected_plan_index` must be a valid index; `employer_hsa_cents > 0` on a plan that is not `hdhp` is a validation error; so is `deductible_cents > oop_max_cents`.

### Properties (Hypothesis, `tests/unit/calc/test_health_plans_properties.py`)

- Every money output is an `int`; `low_cost_cents <= medium_cost_cents <= high_cost_cents <= worst_case_cents` for every plan.
- `0 <= employee_hsa_cents + employer_hsa_cents <= hsa_limit_cents` for eligible plans; `hsa_tax_savings_cents <= employee_hsa_cents`.
- `break_even_spends_cents` is strictly ascending, within `(0, scan_end_cents]` and a multiple of 10,000; it is empty exactly when `w` never changes.
- With a single plan, `pairs` is empty and `recommended_index = 0`.

### Saving a decision

13. Saving a `health_plans` decision follows spec 007 (validate, recompute, compare, store the server's values).
14. `selected_plan_index` must be set; a null is 422 `plan_not_selected` and nothing is saved.
15. When `enrollment_deadline` is set and not before the request's UTC date, the save adds a calendar event `enrollment_deadline` titled "Health plan enrollment deadline", due on that date and linked to the decision. A later version dismisses the earlier version's `upcoming` `enrollment_deadline` events in the same transaction. `DecisionSaved.calendar_event_id` is the new event's id or null; `goal_id` is null.
16. **Explain.** `retrieval/context.py` turns a health-plan decision into facts, each a number (the rate, the three scenario spends, the HSA limit and HDHP thresholds, each plan's yearly premiums, deductible, coinsurance, maximum, employer and employee HSA amounts, tax savings, three scenario costs and worst case, every pair's break-even spends, the salary, paychecks per year and tax year), notes in words (the expected usage and the cheapest plan at it, the plan picked, pairs whose cheaper plan never changes, a capped HSA contribution, a plan labeled `hdhp` below the thresholds, a negative cost and how to write it, rule 17) and up to three benefits passages from the user's `benefits_chunks` for the query `health plan deductible coinsurance out-of-pocket premium HSA`. Plan names are the user's confirmed text, so `retrieval/context.py:name_numbers` passes the numbers inside them ("Gold PPO 2", "Silver $500") to `AllowedNumbers` as allowed values. The four net-cost facts are written as rule 17 says ("$403.00 ahead"), so a draft that repeats one repeats the wording; a negative money value (example 3's low cost) is allowed by its magnitude either way, matching spec 008 rule 13, which already ignores a money token's sign. `verify/fallback.py` writes the code-only fallback from the same numbers, in rule 17's words, cited with the result's `citation_keys` the seed holds (`api/db/seed/irs_citations/health_plans.yaml`).

### Showing a net cost

17. **A negative net cost reads as coming out ahead.** The four net costs (`low_cost_cents`, `medium_cost_cents`, `high_cost_cents`, `worst_case_cents`) are `SignedCents`, and each can be negative: example 3's low cost is -40,300, and a worst case is negative when the employer's HSA money is more than the premiums plus the out-of-pocket maximum (an eligible `hdhp` with no premium, a 170,000 deductible and maximum and 200,000 from the employer costs -30,000 at worst). A negative net cost means the plan leaves the person with more than it takes: the employer's HSA money and the tax saved outweigh the premiums and the care. Printed as "-$403" it reads as an error, so wherever a net cost is shown, a negative one is written as its amount followed by "ahead", with no minus sign: -40,300 is "$403 ahead" in whole dollars and "$403.00 ahead" with cents. Zero and positive costs stay plain money ("$0", "$2,025"). Nothing else in the result is signed: premiums, the plan terms, HSA amounts, tax savings and `break_even_spends_cents` are `Cents`, so they stay plain money.
    - **Why "ahead".** It states the fact (the person ends the year that much ahead) in one plain word that fits a table cell under a cost heading and needs no sign. "Saved" or "savings" would blur into the "Your HSA tax savings" row; "back", "refund" or "credit" promise cash that never arrives (the employer's money stays in the HSA for care, and the tax saved shows up as lower withholding); a "+" is still a sign to decode.
    - **The sign stays the API's.** The calculator returns signed cents and nothing re-signs, compares or recomputes them. Each surface only chooses the words from the sign the API sent, through one pure helper on each side: `web/src/lib/money.ts:formatNetCost` and `api/verify/format.py:net_cost`. The web helper starts from `formatMoney`'s own text, so a cost that rounds to $0 in whole dollars is "$0", never "$0 ahead". The words are shared because one saved decision is read on four surfaces (the health plan step, the Plan page, the Why page's fallback text and the PDF), and a person moving between them should see one number written one way.
    - **Where.** On the health plan step, the comparison table's three usage rows and its worst-case row, and the headline. The headline of a cheapest plan that costs something stays "Gold PPO costs the least at medium use: $2,025 a year"; "costs the least at low use: $403 ahead a year" reads oddly, so a cheapest plan that comes out ahead reads "Bronze HSA costs the least at low use and leaves you $403 ahead a year". Break-even notes print spending, not costs, and do not change. On the Plan page and in the PDF the expected cost and worst case are figures of kind `net_cost` (spec 016 rule 3), so the kind, not a key or a label, says which figures take these words. The fallback explanation says "costs you the least and leaves you $403.00 ahead a year" and "which leaves you $403.00 ahead a year at that use" (example 3 at low use below); the explain context writes the four cost facts the same way and its negative-cost note tells the model to keep that wording.
    - **No color.** An amount ahead keeps the cell's ink: a tone marks a state (web/CLAUDE.md, "Color means something"), and the word carries the meaning.

## 2026 constants

Verified by reading Rev. Proc. 2025-19 (<https://www.irs.gov/pub/irs-drop/rp-25-19.pdf>) on 2026-10-21. Section 2.01(1): "For calendar year 2026, the annual limitation on deductions under § 223(b)(2)(A) for an individual with self-only coverage under a high deductible health plan is $4,400." Section 2.01(2): "a 'high deductible health plan' is defined under § 223(c)(2)(A) as a health plan with an annual deductible that is not less than $1,700 for self-only coverage or $3,400 for family coverage, and for which the annual out-of-pocket expenses (deductibles, co-payments, and other amounts, but not premiums) do not exceed $8,500 for self-only coverage or $17,000 for family coverage."

| Constant | Value | Source |
|---|---|---|
| HSA contribution limit, self-only / family | $4,400 / $8,750 (440,000 / 875,000 cents) | Rev. Proc. 2025-19, 2.01(1) |
| HDHP minimum deductible, self-only / family | $1,700 / $3,400 (170,000 / 340,000 cents) | Rev. Proc. 2025-19, 2.01(2) |
| HDHP maximum out-of-pocket, self-only / family | $8,500 / $17,000 (850,000 / 1,700,000 cents) | Rev. Proc. 2025-19, 2.01(2) |

Brackets and the standard deduction are spec 006's.

## Hand-worked examples

All examples use tax year 2026, filing status single, 26 pay periods, the default scenarios (low 50,000, medium 300,000, high 1,000,000) and `expected_usage = medium` unless stated. The plans:

| Plan | Kind | Premium/pp | Deductible | Coins. | OOP max | Employer HSA |
|---|---|---|---|---|---|---|
| A "Bronze HSA" | hdhp | 2,500 | 170,000 | 20 | 400,000 | 75,000 |
| A' "Bronze HSA" | hdhp | 2,500 | 150,000 | 20 | 400,000 | 75,000 |
| B "Gold PPO" | ppo | 6,250 | 50,000 | 10 | 300,000 | 0 |
| B' "Gold PPO 2" | ppo | 6,250 | 50,000 | 10 | 300,000 | 0 |
| C "Silver HMO" | hmo | 4,000 | 100,000 | 0 | 250,000 | 0 |

Each row is one test in `api/tests/unit/calc/test_health_plans_examples.py` and one case in `evals/fixtures/calc/health_plans.json` (`spec-012-<name>`). Costs are low / medium / high / worst in cents.

| # | Test | Plans | Salary | Employee HSA | Rate | Per-plan HSA (employee, tax) | Costs | Pairs (zero, break-evens, end) | Rec. |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `test_hdhp_versus_ppo` | A, B | 6,500,000 | 100,000 | 12 | A 100,000, 12,000 | A 28,000 / 174,000 / 314,000 / 378,000; B 212,500 / 237,500 / 307,500 / 462,500 | (0,1): 0, [940,000, 1,710,000], 0 | 0 |
| 2 | `test_three_plans_pairwise` | A, B, C | 6,500,000 | 100,000 | 12 | A as 1 | A, B as 1; C 154,000 / 204,000 / 204,000 / 354,000 | (0,1) as 1; (0,2): 0, [450,000, 460,000], 2; (1,2): 2, [], 2 | 0 |
| 3 | `test_hsa_contribution_capped_at_limit` | A, B | 9,000,000 | 500,000 | 22 | A 365,000 (capped), 80,300 | A -40,300 / 105,700 / 245,700 / 309,700; B as 1 | (0,1): 0, [], 0 | 0 |
| 4 | `test_hdhp_below_minimum_deductible` | A', B | 6,500,000 | 100,000 | 12 | A' not eligible: 0, 0 | A' 40,000 / 170,000 / 310,000 / 390,000; B as 1 | (0,1): 0, [980,000, 1,830,000], 0 | 0 |
| 5 | `test_ten_percent_bracket_rounds_half_up` | A | 2,500,000 | 12,345 | 10 | A 12,345, 1,235 | A 38,766 / 184,766 / 324,766 / 388,766 | none | 0 |
| 6 | `test_zero_marginal_rate` | A, B | 1,500,000 | 100,000 | 0 | A 100,000, 0 | A 40,000 / 186,000 / 326,000 / 390,000; B as 1 | (0,1): 0, [820,000, 1,830,000], 0 | 0 |
| 7 | `test_identical_plans_tie` | B, B' | 6,500,000 | 100,000 | 12 | none eligible | both as B in 1 | (0,1): null, [], null | 0 |
| 8 | `test_high_usage_recommends_ppo` | A, B, `expected_usage = high` | 6,500,000 | 100,000 | 12 | as 1 | as 1 | as 1 | 1 |

`scan_end_cents` is 2,550,000 in every example with B or B' (B reaches its maximum at `50,000 + 250,000 * 100 / 10 = 2,550,000`) and 1,320,000 in example 5. `citation_keys` is the three keys of rule 11 in every example except 7, which has no `hdhp` and so only `health.federal_brackets`.

### Arithmetic

**1. HDHP versus PPO.** Salary $65,000; `T = 6,500,000 - 1,610,000 = 4,890,000` ($48,900), over $12,400 and not over $50,400: 12%.
- A is eligible: `D = 170,000 >= 170,000` and `M = 400,000 <= 850,000`. Room under the limit `440,000 - 75,000 = 365,000`, so the requested 100,000 is allowed; tax `100,000 * 12% = 12,000`.
- A's annual premium `2,500 * 26 = 65,000`, so `cost_A(x) = 65,000 + OOP_A(x) - 75,000 - 12,000 = OOP_A(x) - 22,000`.
- `OOP_A(50,000) = 50,000`, low 28,000. `OOP_A(300,000) = 170,000 + 0.2 * 130,000 = 196,000`, medium 174,000. `OOP_A(1,000,000) = 170,000 + 0.2 * 830,000 = 336,000`, high 314,000. Worst `400,000 - 22,000 = 378,000`.
- B: premium `6,250 * 26 = 162,500`; `OOP_B(50,000) = 50,000`, low 212,500; `OOP_B(300,000) = 50,000 + 0.1 * 250,000 = 75,000`, medium 237,500; `OOP_B(1,000,000) = 50,000 + 95,000 = 145,000`, high 307,500; worst `162,500 + 300,000 = 462,500`.
- Break-even. From 170,000 up to A's cap, `cost_A = 0.2x + 114,000`; above 50,000, `cost_B = 0.1x + 207,500`. A stops being cheaper when `0.1x >= 93,500`, `x >= 935,000`; the first scanned point is 940,000 (A 302,000, B 301,500; at 930,000 A 300,000, B 300,500). A caps at `170,000 + 230,000 * 100 / 20 = 1,320,000` and then costs 378,000; B passes that when `0.1x + 207,500 > 378,000`, `x > 1,705,000`; first point 1,710,000 (B 378,500). So A is cheaper at $0, B from $9,400, and A again from $17,100 to the end of the scan.
- Medium usage: A 174,000 is lowest, `recommended_index = 0`.

**2. Three plans.** C: premium `4,000 * 26 = 104,000`; with 0% coinsurance `OOP_C(x) = min(x, 100,000)`, so low `104,000 + 50,000 = 154,000`, medium and high `204,000`; worst `104,000 + 250,000 = 354,000`.
- (0,2): A is cheaper below its deductible (`x - 22,000` against `104,000 + min(x, 100,000)`). Above 170,000, `0.2x + 114,000 = 204,000` at `x = 450,000`: an exact tie at the scanned point 450,000, then C cheaper from 460,000 (A 206,000). A's maximum 378,000 never comes back under 204,000, so C is cheaper at the end. The list is [450,000, 460,000]: into the tie and out of it.
- (1,2): C is cheaper everywhere (at $0: 104,000 against 162,500; from 100,000 on C stays at 204,000 while B is at least 217,500).
- Medium: A 174,000, B 237,500, C 204,000: A.

**3. HSA capped at the limit.** Salary $90,000; `T = 9,000,000 - 1,610,000 = 7,390,000` ($73,900), over $50,400 and not over $105,700: 22%.
- The user asks to contribute 500,000 but the room is `440,000 - 75,000 = 365,000`: capped. Tax `365,000 * 22% = 80,300`.
- `cost_A(x) = 65,000 + OOP_A(x) - 75,000 - 80,300 = OOP_A(x) - 90,300`: low `50,000 - 90,300 = -40,300` (the plan pays the user back on net), medium `196,000 - 90,300 = 105,700`, high `336,000 - 90,300 = 245,700`, worst `400,000 - 90,300 = 309,700`.
- Above 170,000, `cost_A = 0.2x + 45,700` meets `0.1x + 207,500` only at `x = 1,618,000`, past A's cap at 1,320,000; capped A costs 309,700, less than B there (B at 1,320,000 is 339,500). A is cheaper everywhere: no break-even.

**4. A plan labeled HDHP below the 2026 minimum deductible.** A' has `D = 150,000 < 170,000`, so it is not eligible: no employee contribution, no tax savings; the employer's 75,000 still counts.
- `cost_A'(x) = 65,000 + OOP_A'(x) - 75,000 = OOP_A'(x) - 10,000`. `OOP_A'(300,000) = 150,000 + 0.2 * 150,000 = 180,000`; `OOP_A'(1,000,000) = 150,000 + 170,000 = 320,000`. Costs 40,000 / 170,000 / 310,000 / 390,000.
- Above 150,000, `cost_A' = 0.2x + 110,000` meets `0.1x + 207,500` at 975,000: first point 980,000 (A' 306,000, B 305,500). A' caps at `150,000 + 250,000 * 100 / 20 = 1,400,000` at 390,000; B passes it above 1,825,000: first point 1,830,000 (B 390,500).

**5. The 10% bracket and a half cent.** Salary $25,000, `T = 890,000`: 10%. One plan (A), contributing $123.45.
- Tax `12,345 * 10% = 1,234.5`, reported as 1,235.
- `cost_A(x) = 65,000 + OOP_A(x) - 75,000 - 1,234.5 = OOP_A(x) - 11,234.5`: low `38,765.5`, rounds half up to 38,766; medium 184,766; high 324,766; worst 388,766. The rounded parts would give 38,765; rule 7 rounds once from the exact value.
- One plan: no pairs; `scan_end_cents` is A's cap, 1,320,000.

**6. A zero marginal rate.** Salary $15,000 is under the standard deduction, so the rate is 0. A is still eligible and the user may contribute 100,000, but it saves no federal income tax. `cost_A(x) = OOP_A(x) - 10,000`: 40,000 / 186,000 / 326,000 / 390,000. Above 170,000, `0.2x + 126,000` meets `0.1x + 207,500` at 815,000: first point 820,000 (A 290,000, B 289,500). A caps at 1,320,000 at 390,000; B passes it at 1,830,000.

**7. Identical plans.** Every cost is equal at every point, so the pair has no cheaper plan at either end and no break-even; the recommendation tie goes to index 0. No plan is `hdhp`, so the employee HSA request is ignored and only the brackets are cited.

**8. High usage.** Example 1 with `expected_usage = high`: A costs 314,000 and B 307,500 at $10,000 of spending, so B (index 1) is recommended.

The examples were worked by hand and then cross-checked with a throwaway `Decimal` script; the tests, not the script, are the record.

### Writing net costs (rule 17)

Tested in `web/src/lib/money.test.ts` (`formatNetCost`) and `api/tests/unit/verify/test_fallback_and_context.py` (`net_cost`).

| Net cost (cents) | Whole dollars (the comparison table and headline) | With cents (Plan page, PDF, explanations) |
|---|---|---|
| 202,500 | $2,025 | $2,025.00 |
| 0 | $0 | $0.00 |
| -40 | $0 (rounds to zero, so nothing is ahead) | $0.40 ahead |
| -40,300 (example 3, low) | $403 ahead | $403.00 ahead |
| -59,650 | $597 ahead (half up, as `formatMoney` rounds) | $596.50 ahead |

Example 3 at `expected_usage = low` with Bronze HSA picked: the headline is "Bronze HSA costs the least at low use and leaves you $403 ahead a year", and the fallback opens "At low medical use, about $500.00 of care a year, Bronze HSA costs you the least and leaves you $403.00 ahead a year: the employer's HSA money and the tax an HSA contribution saves are more than its premiums and your share of the care." With Gold PPO picked instead it adds "You picked Gold PPO, which costs $2,125.00 a year at that use."

## Edge cases

- One plan: `pairs` is empty, the plan is recommended.
- A plan with 0% coinsurance stops costing more at its deductible; its `worst_case_cents` still uses the stated maximum, which the scenarios never reach.
- A plan with 100% coinsurance pays nothing until the maximum; `cap = M`.
- Coinsurance so low that a plan reaches its maximum only past $1,000,000 of spending: the scan stops at $1,000,000 (rule 8).
- Negative net costs are allowed (`SignedCents`); a cost can never be below `-(H + hsa_limit)`. Every surface writes one as an amount ahead (rule 17).
- `employer_hsa_cents` above the HSA limit: the employee room is 0; the employer amount still counts as given.
- `usage_*_cents` not strictly ascending, `selected_plan_index` out of range, an empty plan list or more than 8 plans: 422.

## Out of scope

- Family and other coverage tiers, and the age-55 HSA catch-up contribution.
- Out-of-network care, copays, separate drug deductibles, and premiums' own pre-tax treatment (premiums are compared at face value; the treatment is the same for every plan an employer offers through a cafeteria plan).
- State income tax and FICA on HSA contributions.
- Growth of HSA balances over time.
