# First Paycheck: slide outline

Eight slides for the December 10 demo. Each has a title, the on-slide text (three to five lines, large type), the speaker note (what to say, matching `script.md`) and the visual. Build the deck from this file in Google Slides or Keynote and export to PDF. Screenshots are in `docs/alpha/screenshots/`; the architecture diagram is the first Mermaid block in `docs/technical-spec.md` section 1, rendered to an image.

## Slide 1. Title

<!-- TEAM: confirm the team statement and the name spellings with both members before the day. The report draft's section 1 holds the wording under review (hkwan16 built the repository alone from October 13 to November 20; Rosman-Carino joined for the hardening milestone on November 26). -->

**Title:** First Paycheck

On-slide text:

- Your first month at a salaried job, decided with your own numbers.
- W-4, health plan, 401(k), emergency fund, safe spending. Then a monthly check-in.
- Hayden Kwan (hkwan16) and Rosman Cariño (Rosman-Carino)
- Stanford CS146S, Autumn 2026
- first-paycheck-silk.vercel.app

Speaker note: "We are First Paycheck. It helps a person through the money decisions of their first month at a salaried job." Then the problem, slide 2.

Visual: the product name large, the pitch under it, the two names and the URL small at the bottom. No screenshot.

## Slide 2. The problem and the user

**Title:** Nobody checks whether your first-month decisions took effect

On-slide text:

- Week one: a W-4, a health plan deadline, a 401(k) form, a first pay stub. No training.
- Budgeting apps ignore taxes and benefits. An advisor costs too much. Articles are not about your numbers.
- After setup, nothing checks: an election that never reached payroll looks the same as one that did.
- Our user: first 30 days at a first salaried job with benefits, a pay stub in hand, a bank account with a few months of history.

Speaker note: the problem paragraph and the user sentence from script part 1. End with "nine features, all in production, nine metrics, seven measured in CI".

Visual: a table on the right with the nine proposal features, each with a check mark (from the report's section 3 table). Keep the text left.

## Slide 3. What we built

**Title:** Tested code does the math. The model proposes. The person confirms.

On-slide text:

- Next.js on Vercel, FastAPI and a job worker on Render, Postgres and Auth on Supabase, Plaid sandbox, Claude Sonnet 5.5.
- Rule 1: all money math in `api/calc/`, integer cents, no model. A boundary test enforces it.
- Rule 2: one module calls Claude, with redacted content only, and logs every call.
- Rule 3: everything the model produces is a proposal until the person confirms it. The confirm route refuses a stub whose gross minus deductions is not net.

Speaker note: the three rules, one sentence each. Point at the blue boxes on the diagram: "These are the only parts that touch a model. Everything else is plain, tested code."

Visual: the architecture diagram from `docs/technical-spec.md` section 1 (the first Mermaid flowchart, with the LLM gateway and the Claude API in blue), rendered to PNG at the deck's width. The three rules as a column beside it.

## Slide 4. Live demo

**Title:** Live

On-slide text:

- first-paycheck-silk.vercel.app
- Link, Confirm, Spending, Decisions, Why, Plan and Check-in
- Synthetic data. Plaid sandbox.

Speaker note: switch to the browser window. Follow the numbered click path in `script.md` part 2. This slide stays behind the browser; if production fails, advance to the backup screenshots behind it (slides 4a to 4f, hidden in the deck's navigation, shown only on failure).

Visual: the three lines centered on a plain background. Behind it, six hidden backup slides, one screenshot each, full bleed with a one-line caption: `01-link-accounts.jpg`, `03-confirm-review.jpg`, `05-spending-cash-flow.jpg`, `07-decisions-401k.jpg`, `09-why-verified.jpg`, `12-check-in-cash-flow.jpg`. The recording `docs/alpha/alpha-demo.mp4` is the first fallback; these are the second.

## Slide 5. How we built it with AI

**Title:** Specs first, rules in CLAUDE.md, agents in parallel, QA in the browser, evals with baselines

On-slide text:

- 19 feature specs with hand-worked examples; tests are written from the examples.
- `CLAUDE.md`: eight rules, enforced by tests and lint, not by the prompt.
- October 21: 16 Opus subagents built M3 to M10 in one day. API tests 733 to 1,922; web 605 to 1,332.
- Claude in Chrome clicked through production four times: 79 issues found with CI green.
- 11 eval suites with measured baselines; a released prompt is never edited.

Speaker note: script part 3. Close with the numbers line: "781 commits, about 5,000 tests, 36 AI log entries, 79 production bugs found by AI-driven passes."

Visual: a row of five large numbers across the bottom (781 commits, about 5,000 tests, 36 AI log entries, 79 production bugs, 98% and 97.6% coverage). Above it the five bullets. Optional: a small screenshot of a `docs/ai-log.md` entry heading.

## Slide 6. The scorecard

<!-- USER TEST: if the moderated test runs before December 10, replace the two "Not measured" rows with the results from docs/user-test/results.md and change "seven met, two unmeasured" to the new count here and in script.md part 4. -->

**Title:** Nine metrics. Seven met. Two need people.

On-slide text (as a table):

| Metric | Target | Measured |
|---|---|---|
| Extraction accuracy | 95% | 1.0 over 39 documents, 442 fields |
| Categorization accuracy | 90% | 1.0 over 547 rows |
| Recurring detection | 90% precision and recall | 1.0 precision, 0.95 recall |
| Calculator correctness | 100% | 46 of 46 spec examples |
| Check-in findings | 100% | 22 of 22 scenarios |
| Explanations citing a source | 100% | 1.0 on 43 decisions |
| Fallback rate | at most 5% | 0% |
| Setup in two sittings | 80% of users | Not measured |
| Understanding gain | +2 points | Not measured |

Footer line: Coverage 98% of statements on the API, 97.6% on the web.

Speaker note: read the met rows fast, then slow down on the two unmeasured rows: "They need people, not CI. The test kit is written and has not run. We say so rather than claim it."

Visual: the table, with the seven met rows in the confirmed tone and the two unmeasured rows in a neutral grey. Nothing else on the slide.

## Slide 7. What went wrong and what we changed

**Title:** Four failures a person had to notice

On-slide text:

- `ABTHROPIC_API_KEY`: production ran a day with no model and looked healthy. Now it refuses to start without the key.
- A verified explanation misled: every number matched, but a planned withholding was called the one in effect. Fix: the stub's figure in the context, plus a judge that reads framing.
- A regression test passed with the fix removed. Fix: make it fail first, then check its own precondition.
- Fifty PRs merged without a review, against our own spec. Fix: cross-review from November 26; the first reviews caught three things the gates passed.

Speaker note: script part 4, the four examples and the "how the approach adapted" sentence: briefs name the migration head and a private database; prompts are versioned; every bug is reproduced end to end; someone other than the author reads every branch.

Visual: four short rows, each with a one-word label on the left (Key, Verifier, Test, Review) and the before and after on the right. Optional small screenshot: the issue 181 explanation text with $423.16 beside the stub's $272.44.

## Slide 8. What is next

**Title:** What is next

On-slide text:

- Run the moderated user test for the two unmeasured metrics (5 to 8 people, kit in `docs/user-test/`).
- Apply for Plaid production access; the pipeline does not change.
- Design and test for phones; the product is desktop only since November 1.
- The savings priority ladder, then an employer version as a financial-wellness benefit.
- github.com/hkwan16/First-Paycheck

Speaker note: one sentence each, then "Thank you. We are happy to take questions."

Visual: the five lines, the repo URL and the app URL large at the bottom. Optional: `10-plan.jpg` faded behind as a backdrop.
