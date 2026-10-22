# Feature specs

Every feature starts here, before code. A spec states what the feature must do precisely enough that its tests can be written from it alone, and an agent or a teammate can build it without guessing. When requirements change, the spec changes first, in the same pull request as the code.

## File names

`NNN-slug.md`, numbered in the order specs are written: `001-data-model.md`, `006-401k-match.md`. Numbers are never reused.

## Sections

Every spec has these sections, in this order. A section that does not apply says so in one line rather than disappearing.

| Section | What it holds |
|---|---|
| **Goal** | One paragraph: what the feature does for the user and where it lives in the code. |
| **Inputs** | Every input with its type and valid range. Money is integer cents (`Cents`, named `*_cents`), percentages are `Decimal`, dates are ISO dates, timestamps are UTC. |
| **Outputs** | Every output with its type and meaning. |
| **Rules** | Numbered, each one testable on its own. Rounding, boundaries and precedence are spelled out, not implied. |
| **Hand-worked examples** | A table where each row is one named test. Show the arithmetic for each row below the table, so a reviewer can check it without running code. Use real, cited constants; if a figure cannot be verified, the row says "pending verification" and the test is marked `xfail` until it is. |
| **Edge cases** | Inputs at boundaries, empty inputs, invalid inputs and what each returns. |
| **Out of scope** | What the feature deliberately does not do, so nobody adds it by accident. |
| **Status** | One of Draft, Ready, Implemented, Superseded, with the milestone and any examples still pending. Put it at the top of the file. |

Specs may add an **Open questions** section for decisions not yet made. A spec with open questions that affect a rule or an example stays Draft.

## How specs become tests

- Each hand-worked example row becomes one test whose name is the row's test name, in the test file the spec names.
- Each numbered rule that is not covered by an example gets its own test or a property test.
- External constants (IRS limits, brackets, Plaid conventions) are cited with a URL in the spec, and the constants file in code notes the same source.

## Index

| Spec | Status |
|---|---|
| [001 Data model](001-data-model.md) | Draft, M0 |
| [002 Sync pipeline, Plaid, webhooks and jobs](002-sync-pipeline.md) | Implemented, M1 |
| [003 Categorization, the LLM gateway and transaction routes](003-categorization.md) | Implemented, M1 |
| [004 Upload, ingest and redaction](004-ingest-and-redaction.md) | Implemented, M2 |
| [005 Pay stub and benefits extraction, review and confirm](005-pay-stub-extraction.md) | Implemented, M2 |
| [006 401(k) match calculator](006-401k-match.md) | Implemented, M3 |
| [007 Decisions, versioning, the calendar and the spending summary](007-decisions-and-versioning.md) | Implemented, M3 |
| [008 Explain, verify, citations and retrieval](008-explain-and-verify.md) | Implemented, M3 |
| [009 Recurring charges](009-recurring-charges.md) | Implemented, M5 |
| [010 Cash flow and CSV import](010-cash-flow-and-csv-import.md) | Implemented, M5 |
| [011 Emergency fund calculator, goals and their calendar](011-emergency-fund.md) | Implemented, M6 |
| [012 Health plan comparison calculator](012-health-plans.md) | Implemented, M6 |
| [013 Benefits extraction: health plans, the 401(k) match and vesting](013-benefits-extraction.md) | Implemented, M6 |
| [014 W-4 withholding calculator](014-w4.md) | Implemented, M7 |
| [015 Monthly check-ins, net worth and holdings](015-check-ins.md) | Implemented, M8 |
