# Facilitator script

About 45 minutes: 5 to set up and consent, 5 for the first quiz, 25 for the tasks, 5 for the
second quiz, 5 to debrief. Two people run each session: the facilitator, who talks, and a note
taker, who fills in `observation-sheet.md` and keeps time. Lines in quotes are said as written;
the rest is for you.

## Setup (before the participant arrives)

- [ ] The test laptop is signed out of the app, with a fresh browser window at the sign-in page.
- [ ] This participant's test account (`usertest-NN@example.com`) works; its password is on the
      persona card.
- [ ] `Acme pay stub.pdf` (the synthetic stub) is on the desktop.
- [ ] The persona card and the Plaid sandbox card are printed (below).
- [ ] Two blank quizzes, one observation sheet and two consent forms are ready.
- [ ] Screen recording is ready but not started.

## 1. Welcome and consent (5 minutes)

"Thanks for coming. Today you will try an early version of an app called First Paycheck, which
helps someone with their first salaried job make their first-month money decisions. We are testing
the app, not you: if anything is confusing, that is the app's fault, and it is exactly what we want
to find."

Read `consent.md` aloud, answer questions, and get it signed. If they allow recording, start it
now.

"Everything you will use today is made up: a test account, a pretend bank and a pay stub we
created. Please do not type anything real about yourself. If a screen asks for something, use the
card I give you."

## 2. Before quiz (5 minutes)

"First, five quick questions. Answer what you think right now. 'I do not know' is a perfectly good
answer, and I will not tell you the answers until the end."

Hand over the quiz marked Before. Do not help. Collect it face down.

## 3. Tasks (25 minutes)

"I will give you a few tasks. Please think aloud as you go: say what you are looking for, what you
expect to happen, and anything that surprises you. I may not answer questions during a task,
because I want to see how the app does on its own, but I will help if you get stuck."

Hand over the persona card and the Plaid sandbox card:

> **Persona: Jordan Rivera.** Just started at Acme Corp, paid twice a month. Salary $65,000 a
> year. Single. Born in 1996. Acme matches 100% of what you put into your 401(k), up to 4% of
> your pay.
>
> **Test account:** `usertest-NN@example.com`, password on this card.
>
> **Plaid sandbox bank:** First Platypus Bank. Username `user_good`, password `pass_good`. If asked
> for a code, `1234`.

For each task: read it aloud, start the note taker's timer when you finish reading, and stop it
when the success line is met or the participant gives up. If they are stuck for 2 minutes, give
the hint, and mark the task "with help". After each task, ask the ease question.

**Ease question (after every task):** "On a scale of 1 to 7, where 1 is very hard and 7 is very
easy, how easy was that?"

### Task 1: Sign in

"You have just been given an account for First Paycheck. Sign in with the details on your card."

- Success: the Link screen, "Link your accounts and add your documents", is showing.
- Hint: "The email and password are on the card."

### Task 2: Link your bank

"Connect the bank account your paycheck goes into, using the sandbox bank on your card."

- Success: First Platypus Bank's accounts are listed under Bank accounts, the sync has finished,
  and the checking account's Role is Spending.
- Watch for: whether they find "Link a bank with Plaid", how they react to Plaid's window, whether
  they understand the Role select without being told.
- Hint: "Look in the Bank accounts card."

### Task 3: Add your pay stub

"Upload your first pay stub. It is the file called Acme pay stub on the desktop."

- Success: the pay stub row says "Review needed", with how many items were redacted.
- Watch for: whether they notice the redaction note ("Before any AI sees a page...") and the
  redaction count, and what they think it means. Ask afterwards: "What do you think happened to
  your Social Security number on that stub?"
- Hint: "Look in the Documents card, under the bank accounts."

### Task 4: Check what was read

"Check that the app read your pay stub correctly, and confirm it."

- Success: the Spending screen opens after "Confirm and continue", with "The math checks out"
  seen on the way.
- Watch for: whether they compare fields with the source pane, whether they edit anything, whether
  "Confirm all remaining" feels safe to them.
- Hint: "Use Review pay stub on the pay stub row."

### Task 5: Read your spending

"Without counting anything yourself, tell me how much of last month's pay you took home, and what
your biggest category of spending was."

- Success: they read the take-home figure from the summary tiles (or the diagram) and name the
  largest category.
- Watch for: which part of the screen they use, whether the bucket names (essentials, flexible)
  make sense, whether they notice the "who labeled it" badges.
- Hint: "Start with the totals at the top."

### Task 6: Decide your 401(k)

"Go to your decisions. Choose how much of your pay to put into your 401(k) so you get your
employer's full match, and save that choice."

- Success: the 401(k) card says "Saved as v1" at 4% (or more), and the headline says the full match
  is captured.
- Watch for: the plan details form (salary, filing status, match, birth year; all on the persona
  card), how they move the slider, whether they read what the change costs per paycheck.
- Hint: "Use these numbers in decisions, at the bottom of the Spending screen."

### Task 7: Read why

"Find out why the app suggests that contribution, and tell me in your own words."

- Success: the Why screen is open with "Verified against calculator", and they explain the match in
  their own words.
- Watch for: whether they open a source link, whether they trust the explanation more or less
  after seeing it was checked against the calculator.
- Hint: "Look for Why this decision on the 401(k) card."

## 4. After quiz (5 minutes)

"Now the same five questions again. Answer what you think now."

Hand over the quiz marked After. Collect it. Only now, if they want, go through the answer key in
`quiz.md` with them.

## 5. Debrief (5 minutes)

Ask, and let the note taker write the answers down as said:

1. "What, if anything, did you learn today that you did not know before?"
2. "Was there a moment you were unsure what to do next? Where?"
3. "Was there a number on screen you did not trust? Which one, and why?"
4. "If this were your real first job, would you finish setting it up in one go, or come back
   later? What would make you stop?"
5. "If you could change one thing, what would it be?"

"Thank you. Everything you entered was made up, and I will delete the test account now."

Stop the recording. Then, with the participant gone, sign in as the test account, open the
account menu, choose Delete account, type `delete` and confirm. Record the time on the
observation sheet, and score both quizzes on the scoring sheet in `quiz.md`.

## Notes for the facilitator

- Do not lead: ask "What are you looking for?" instead of "Did you see the button?".
- Do not explain money concepts during the tasks; that would spoil the after quiz.
- If something breaks (a sync that never finishes, an error notice), note the exact words on screen
  and the time, then help them past it and mark the task "with help". A bug is a finding, not a
  failed session.
- "Finished in one sitting" is Yes when tasks 1 to 6 all succeeded, with or without help.
