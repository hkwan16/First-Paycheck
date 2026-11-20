/*
 * The entry limits the API states for what a person types on a decision form
 * (spec 007 rule 2a, issue 238), mirrored so a form can say what is allowed
 * before it sends anything (spec 018 rule 5e). `entry-limits.test.ts` reads
 * each one back from `api/openapi.json`, so a limit changed in the API fails
 * here until the mirror follows. A relation between two amounts, or a limit
 * that depends on the tax year (an employer's HSA contribution), is never
 * mirrored: the API decides it and the form shows its answer beside the field.
 */

/** A yearly amount: a salary, wages, income, deductions, a deductible: $10,000,000.00. */
export const MAX_YEARLY_CENTS = 1_000_000_000;

/** A monthly or per-paycheck amount: essentials, a transfer, a premium: $1,000,000.00. */
export const MAX_PERIOD_CENTS = 100_000_000;

/** Any other amount the API takes, such as a savings balance: $1,000,000,000.00. */
export const MAX_BALANCE_CENTS = 100_000_000_000;

/** Form W-4 Step 3's credits for the year: $100,000.00 (spec 014 rule 16a). */
export const MAX_STEP3_CREDITS_CENTS = 10_000_000;

/** The earliest birth year `PUT /profile` takes. */
export const MIN_BIRTH_YEAR = 1900;

/** The youngest age most employers may hire, under the Fair Labor Standards Act. */
const MIN_WORKING_AGE = 14;

/** The last birth year `PUT /profile` takes in `year`: 2012 in 2026 (spec 006 open question 2). */
export const latestBirthYear = (year: number) => year - MIN_WORKING_AGE;
