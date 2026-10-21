# CS146S Aut26 Final Project Proposal

## Problem Statement

Early-career employees starting their first salaried job face many high-stakes financial decisions in their first month, usually with no training. They are required to fill out a W-4, choose a health plan, set a 401(k) contribution, and figure out what they can safely spend. These are consequential decisions. Budgeting apps ignore personalized benefits and taxes and financial advisors are too expensive on a first salary. Online articles are not personalized to the reader's own numbers.

We will attempt to solve this problem by creating an app that uses AI to guide a new employee through their first-paycheck decisions and explaining each one with their own numbers, offer letter, and healthcare plans.

## Target User

Our target user is an early-career employee, recently starting their first salaried job with benefits. Every feature is designed around this person's first 30 days on the job, and around the yearly checkpoints that follow.

- **Context:** an offer letter or first pay stub, a benefits enrollment deadline, a bank account with a few months of history, and little financial training.
- **Goals:** make choices aligned to the user's goals before deadlines pass, know what they can safely spend, and start building security.
- **Needs:** answers tied to their own salary, benefits, and spending, with explanations that are cited from reliable sources.

## Initial Business or Use Case

**Context Setting.** In their first weeks at a new job, the user links their bank accounts (or uploads a CSV), uploads a pay stub or offer letter and their benefits summary, then completes a guided setup in one or two sittings. They check in monthly to see whether their decisions took effect and what changed, and return at yearly checkpoints such as open enrollment, tax season, and life events such as a raise.

**Value.** Every recommendation explains the concept, applies it to the user's own numbers, and shows what different decisions might alter their financial future. Users leave with a setup plan and the understanding to make the next decision themselves.

**Business context.** Free for individuals, or sold to employers as a financial-wellness benefit for new hires (employer sales are out of scope for the class project). The monthly check-in and the decision calendar drive return visits.

## Planned Features

One guided flow in which each step feeds the next. Financial math runs in deterministic, tested code; the LLM handles extraction, categorization, and explanations.

### MVP (must-have)

1. **Bank sync and spending map:** link accounts through Plaid (sandbox for the class project) or import a CSV; both feed one pipeline. Transactions are auto-categorized (rules first, AI only for unknown merchants, user-correctable), and monthly essentials, flexible spending and savings rate are computed.
2. **Paycheck decoder:** extract and explain each line of a pay stub or offer letter (PDF or image). Extraction runs as a background job after redaction, and the user confirms each field; a pay stub is saved only when gross minus deductions equals net. Federal lines are computed and explained; state tax lines are labeled but not computed.
3. **Emergency fund goal:** size a 3–6 month target from essentials and current savings, show time-to-goal at different savings rates, and track progress against the linked savings account.
4. **401(k) match optimizer:** show the contribution that captures the full match, the dollars gained or lost, and what the change costs per paycheck before and after federal income tax.
5. **Health plan comparison:** HSA-eligible high-deductible plan vs. PPO, with expected cost and break-even point, based on the user's expected healthcare usage.
6. **W-4 walkthrough:** guided form completion with a projected federal refund or balance due.
7. **"Why" explanations:** the concept, the user's numbers, and what would change the answer, grounded in IRS and plan sources.
8. **Saved plan and decision calendar:** persist versioned decisions and reasoning, export a one-page plan, and list the user's dated checkpoints (enrollment deadline, tax season, open enrollment).
9. **Monthly check-in:** when new data arrives, diff it against the plan and surface what changed: a 401(k) election that doesn't match the latest pay stub, a goal off pace, a new or changed recurring charge, a pay or deduction change, an upcoming deadline. Each finding links to the calculator it affects. Includes cash flow for the month against the plan's targets, net worth across linked accounts, and investment holdings for retirement accounts.

### Stretch (nice-to-have)

- **Plaid production access:** real institutions instead of the sandbox; the pipeline does not change.
- **Savings priority ladder:** Roth IRA vs. 401(k) guidance with what-if toggles.
- **Employer organization layer:** for the financial-wellness benefit.

## AI Tool Usage Plan

- **Code generation and refactoring:** Claude Code and Cursor scaffold the app and build parsers and calculators from specs we write first.
- **Automated testing:** AI-generated unit and property-based tests for every calculator, plus an eval set of labeled pay stubs, offer letters, benefit summaries, and transactions measuring extraction and categorization accuracy.
- **Code review and QA:** AI review on every PR, plus a human approval.
- **UI/UX prototyping:** AI-generated clickable mockups of the setup flow.
- **CI/CD and deployment:** AI-written GitHub Actions run lint, tests, and evals on each PR, and block merges on eval regressions.

We will log where AI helped, where it failed, and how we caught it, for the final reflection.
