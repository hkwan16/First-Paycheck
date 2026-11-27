# First Paycheck: demo day script

Thursday, December 10, 2026, 7:00 to 10:00 PM. The room opens at 6:30. The teaching team circulates and grades each project; guests may attend. The handout asks for a 5 to 8 minute presentation in four parts: context and requirements, a working demo, LLM and AI integration, and reflection. This script runs 7 minutes with a 5-minute cut marked in each part. Read it aloud twice on production (December 8 and 9) before the day.

## Before we start

Logistics checklist, in order:

- [ ] 6:30. Arrive. Find the table, the power outlet and where the graders walk from.
- [ ] Laptop, charger, phone hotspot turned on and tested once as a second network.
- [ ] 6:45. Warm the API: `curl https://first-paycheck-api.onrender.com/health`. The Render free instance sleeps after 15 idle minutes, so run it again every few minutes while waiting, and once more right before we are graded. The answer names the commit, the migration and a live worker.
- [ ] Sign in as the synthetic test user in advance. Open <https://first-paycheck-silk.vercel.app/setup/link> and check that the seven sandbox accounts and the documents list are on screen.
- [ ] Have `docs/alpha/alpha-demo.mp4` (111 seconds, recorded from production November 1) downloaded to the desktop and opened once in a player, paused at the first frame. The screenshots in `docs/alpha/screenshots/` are the second fallback and sit behind the demo slide in the deck.
- [ ] One browser window, Chrome, 1280 wide or wider, zoom at 125% so the back row can read the tiles. The deck in a second window, not a tab. No other tabs, bookmarks bar hidden, notifications off.
- [ ] Check that the test user has an unconfirmed Acme pay stub waiting on the Link page. If not, upload it (`web/e2e/support/capture.ts` holds the fixture) before 6:50 so the worker has read it by the time we present.
- [ ] Check what the 401(k) slider is saved at. We move it to 4% (or to 5% if 4% is saved) so there is a version to save.
- [ ] If two of us present: one speaks parts 1 and 4, the other drives the demo and speaks parts 2 and 3. Hand over at the slide change, not mid-sentence.

## Time budget

| Part | Full (7:00) | Rushed (5:00) |
|---|---|---|
| 1. Context and requirements | 1:00 | 0:45 |
| 2. Working demo | 3:30 | 2:30 |
| 3. LLM and AI integration | 1:15 | 0:50 |
| 4. Reflection and learnings | 1:15 | 0:55 |

If a grader says they have five minutes, use the cut marked **Rushed** in each part. The rushed demo path drops Spending and the Plan page and keeps Confirm, Decisions, Why and the Check-in.

## Part 1. Context and requirements (1:00)

Slides 1 to 3.

We are First Paycheck. It helps a person through the money decisions of their first month at a salaried job.

Here is the problem. A new hire gets a W-4, a health plan choice with a deadline, a 401(k) form and a first paycheck, usually with no training. Budgeting apps ignore taxes and benefits. An advisor costs too much on a first salary. Articles are not about the reader's numbers. And after setup, nothing checks whether the decisions took effect. A 401(k) election that never reached payroll looks the same as one that did.

Our user is in their first 30 days at a first salaried job with benefits. They have a pay stub, a benefits deadline and a bank account with a few months of history.

We proposed nine features: bank sync and a spending map, a paycheck decoder, an emergency fund goal, a 401(k) match optimizer, a health plan comparison, a W-4 walkthrough, verified explanations, a saved plan with a calendar, and a monthly check-in. All nine are in production.

We set nine success metrics with a measurement for each. Extraction accuracy, categorization accuracy, recurring detection, calculator correctness, check-in correctness, citation rate and fallback rate are measured by eval suites in CI. Two, setup in two sittings and an understanding gain, need a user test. We will come back to the scorecard.

Three rules hold the system together. All money math lives in tested Python over integer cents, with no model in it. One module may call Claude, and it sends redacted content only. Everything the model produces is a proposal until the person confirms it.

**Rushed (0:45):** drop the paragraph on the nine features and say "nine features, all in production". Keep the problem, the user and the three rules.

## Part 2. Working demo (3:30)

Slide 4 says "live" and stays up while the browser window is in front. Production: <https://first-paycheck-silk.vercel.app>, signed in as the synthetic test user. Say the sentence in *italics* while each page loads. The data is synthetic; say so once at the start.

1. **Link.** We are on the Link page. *"Everything you see is synthetic data from the Plaid sandbox."* Point at the seven linked accounts, each with a role word: Spending, Emergency fund, Retirement, or Not used. Notice that the roles are plain words, and that the calculators downstream read them. Scroll to the documents list. Point at the pay stub row and its redaction badge. Say: "Social Security and account numbers were blacked out before the model saw a page."
2. **Confirm.** Click the pay stub row. *"Claude read the stub in a background job while we were talking; the screen shows what it proposed."* Notice the redacted stub on one side and the proposed fields on the other, each with a confidence. Click Gross pay; its line on the stub is outlined. Say: "Every field is a proposal. Nothing counts until we confirm it." Confirm one field (Gross pay) and point at the arithmetic gate under the card: gross minus deductions must equal net. Say: "If the numbers do not add up, the screen says so and the API refuses the save with a 422. Both sides check." Finish confirming the fields, wait for "The math checks out." and click Confirm and continue.
3. **Spending.** *"Spending comes from the bank's transactions; the pay figures come from the stub we just confirmed."* Notice the five tiles: Income deposited, Essentials, Flexible, Savings and Other, with "Left over" under them. Say: "The five tiles add up to what is left over." Scroll to the cash-flow diagram and hover the Essentials bucket. Notice the popover listing the categories its money went to. Scroll to the transactions. Point at three source badges: Known merchant (a rule), Our guess with its confidence (the model), and You (a fix by the person). Change one category. Say: "That fix just became a rule. This merchant never goes back to the model."
4. **Decisions.** Click Use these numbers in decisions, then Next: 401(k) match. *"Four decisions, one calculator each. The model never does the math."* Notice the employer's match terms and the "Contribution for the full match" figure. Move the slider one step at a time with the arrow keys and watch the figures rerun: what we put in, what the employer adds, the match we miss, the extra per paycheck before and after federal tax. Say: "Every number here comes from `api/calc/`, which has 45 property tests on top of the spec's hand-worked examples." Click Save. The button reads Saved. Point at the chip near the step heading, which reads "4 of 4 saved" (or, with #292 live, "4 of 4 saved, 2 need review"). Say: "Saving kept a new version. The old one is not overwritten; it is kept as v1, and the Why page shows both."
5. **Why.** Click Why each decision in the side nav, then 401(k) match. *"Claude wrote this from the calculator's numbers and the IRS passages we retrieved; plain code is checking it."* If the explanation is already written, notice the confirmed note: "We checked every number here against the decision you saved, and each source links to the IRS page it quotes." Say: "The verifier matched every number in the text to a calculator output. On the alpha recording that was 25 of 25 numbers and 3 of 3 citations. If a check fails, it retries once and then shows the calculator's own result, flagged as a fallback." Scroll to Sources. Click "What it says" under one citation to show the quoted IRS passage.
6. **Plan and check-in.** Click Plan and calendar. *"One page: the paycheck, each decision, and the next 90 days."* Point at the PDF and calendar buttons. Say: "The PDF and the `.ics` file are made by the worker, in tested code." Click Monthly check-in. Open the most recent month. Notice "What changed": each finding names the part of the plan it affects, such as a new recurring charge or a 401(k) election that never reached the pay stub. Click All check-ins and open the month before. Scroll to the cash flow against the plan. Point at the savings line reading "Ahead of plan". Say: "Each month we ask whether the decisions took effect. That is the part no budgeting app does."

Close with one sentence: "Every number came from tested code. What the model produced was a proposal until the person confirmed it."

**Rushed (2:30):** steps 2, 4, 5 and the check-in half of step 6. Skip Spending (say: "Spending shows the five tiles and the cash-flow diagram; we will skip it") and skip the Plan page.

### Steps that depend on open pull requests

These four pull requests were open on November 27. Check which have merged on December 9 and use the fallback wording for any that have not.

| Step | Depends on | If it is live | If it is not live |
|---|---|---|---|
| 3. Spending, the Other tile | PR #278 (issue 268) | "The five tiles add up to what is left over." | Four tiles are shown. Say: "Income, essentials, flexible and savings; debt payments and fees are in the diagram's grey Other bucket, and a fix on review adds a fifth tile." |
| 4. Decisions, the saved chip | PR #292 (issue 257) | "4 of 4 saved, 2 need review" matches the card and the side nav. | The chip reads "4 of 4 saved" only. Do not point at it; point at the Saved button and the Why page's version list instead. |
| 6. Check-in, "Ahead of plan" | PR #295 (issue 269) | "Saving more than planned reads Ahead of plan." | The line reads "Over plan" in a green tone. Say: "Saving more than planned is good; the tone says so and the wording is fixed in a pull request on review." |
| Account menu, Delete account | PR #291 (issue 267) | Only if asked about deletion: open the menu, click Account, then Delete account. The dialog asks the person to type "delete". | The menu shows Sign out and Delete account together. Say the same thing about the dialog; do not open the menu unprompted. |

Also open on November 27: PR #277 (issue 265) gives a loan a checkbox instead of a role picker and explains "No role" and "Not used" on the Link page. If it is not live, say "roles" and move on without opening a loan's picker.

### If something breaks

| What happens | What to do |
|---|---|
| The API is asleep (skeletons for a minute, or `/health` times out) | Say: "The API runs on a free instance that sleeps when idle; here is the same path recorded from production on November 1." Switch to `alpha-demo.mp4` and narrate steps 1 to 6 over it. Keep the curl running in a terminal; if it answers before the Why step, go back to the live app for Why onward. |
| The explanation is not written ("No explanation yet") | Click Write the explanation. While it runs, about 20 seconds, talk through the verifier: the model writes from the calculator's numbers and the retrieved IRS passages; plain code checks every number against a calculator output and every citation against the retrieval set; one retry, then a flagged fallback showing the calculator's own result. If it falls back, say so: "That is the fallback working as designed," and click Try again. |
| Plaid Link's iframe is slow or does not open | We never open Plaid Link on stage. If someone asks to see it, say the sandbox link runs through a non-production route and the accounts on the Link page came through it. Skip to the already-linked accounts. |
| Wi-Fi drops | Switch to the phone hotspot (checked at 6:30). If the app does not come back in 30 seconds, go to the recording. |
| A screen shows a stale or empty state we did not expect | Say what it is, do not debug it on stage, and move to the next step. Note it for the production pass. |
| A question we cannot answer | Say: "We do not know that off hand." Point at the report (`docs/final/report.md`) or the AI log and offer to follow up. Do not guess a number. |

## Part 3. LLM and AI integration (1:15)

Slide 5.

We built this with Claude Code, and the way we built it is the second half of the story.

Specs first. Every feature started as a short spec with inputs, outputs, numbered rules and hand-worked examples. Agents wrote tests from those examples. Nineteen specs exist.

Context files. The root `CLAUDE.md` holds eight rules: money math only in `api/calc/`, one module may import `anthropic`, every query under row-level security, a failing test before every fix, no em dash, fix root causes, synthetic data only, and a generated API contract. The rules are enforced by tests and lint, not by the prompt. A boundary test fails if the calculators import anything but the standard library and Pydantic.

Parallel agents. On October 21, sixteen Opus subagents, two to four at a time, each in its own worktree with its own test database and a gated command, built milestones M3 to M10 in one day. Test counts went from 733 to 1,922 on the API and 605 to 1,332 on the web. The cost was orchestration: a third of the main session went to merges.

QA with Claude in Chrome. Four passes clicked through production as the test user and found 79 issues with CI green each time. Among them: a misspelled key that let production start healthy with no model, and a paused goal that still said it was on pace.

Evals with baselines. Eleven suites, six free and five with the live model, each with a measured baseline and a tolerance per case. A released prompt is never edited; a new version gets its own baseline.

The numbers: 781 commits, about 5,000 tests, 36 AI log entries, 79 production bugs found by AI-driven passes, coverage 98% on the API and 97.6% on the web.

**Rushed (0:50):** say the three rules in one sentence, then parallel agents and the Chrome QA, then the numbers line.

## Part 4. Reflection and learnings (1:15)

Slides 6 to 8.

The scorecard. Nine metrics, seven met. Extraction accuracy 1.0 over 39 documents and 442 fields against a 95% target. Categorization 1.0 over 547 rows against 90%. Recurring detection precision 1.0 and recall 0.95 against 90%. Calculators 46 of 46 spec examples. Check-ins 22 of 22 scenarios. Citations 1.0 and fallback 0% on 43 decisions. Two are unmeasured: setup in two sittings and an understanding gain. They need people, and the moderated test kit is written but has not run. We say so rather than claim it.

Where the AI tools were most effective: volume with discipline. A five-week plan landed in a day, every merge gated, and testing production like a person found bugs that unit tests passed over.

Where they were least effective: they failed in ways a person had to notice. Four examples.

The misspelled key. `ABTHROPIC_API_KEY` on Render. Production started without a model, fell back to rules and manual entry as designed, and looked fine for a day. The fix was a refusal to start without the key, not a prompt.

The verifier that accepted a misleading explanation. The W-4 explanation said $423.16 was withheld per paycheck now, while the stub withheld $272.44. Every number matched, because the context had labeled the planned figure as the current one. The fix was in what the model was shown, plus an LLM judge that reads framing.

The test that tested nothing. A regression test for a scroll bug passed at desktop width with the fix removed. A scan of window heights found the bug only between 625 and 675 pixels tall. The test now runs there and checks its own precondition.

Fifty pull requests without a review. The spec promised a review on every PR. The first fifty were merged by their author with none. Cross-review started on November 26, and the first reviews caught three things the gates had passed.

How the approach adapted: briefs name the migration head and a private database; prompts are versioned, never edited; every bug is reproduced end to end and kept as a regression test; someone other than the author reads every branch.

What is next: run the user test for the two unmeasured metrics, apply for Plaid production, design for phones, build the savings priority ladder, and the employer version.

Thank you. We are happy to take questions.

**Rushed (0:55):** scorecard in two sentences (seven of nine met, two need a user test), two failures (the key and the verifier), then the review gap and what is next in one sentence each.
