import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CALCULATOR_LABELS } from '@/lib/decisions';
import { PAYCHECK_LINES, PAYCHECK_TILES } from './plan-format';

/*
 * The PDF is the Plan page on paper (spec 016 rule 11a, issue 239): where the
 * two say the same thing they use the same words. The API renders the plan
 * user's page byte for byte as this fixture (its test_html_matches_the_fixture),
 * so reading it here fails the web side when either one renames something.
 */
const pdf = readFileSync(resolve(process.cwd(), '../api/tests/fixtures/export/plan.html'), 'utf8');

/** The section of the page under the `<h2>` named `from`, up to the next `<h2>`. */
function section(from: string): string {
  const start = pdf.indexOf(`<h2>${from}</h2>`);
  if (start < 0) throw new Error(`The PDF has no "${from}" section`);
  const end = pdf.indexOf('<h2>', start + 1);
  return pdf.slice(start, end < 0 ? undefined : end);
}

const captures = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].map((m) => m[1]);

describe("the plan PDF's words", () => {
  it('name each decision as the Plan page does', () => {
    // The plan user has saved all four, in calculator order.
    expect(captures(section('Decisions'), /<span class="name">\d+\. ([^<]+)<\/span>/g)).toEqual(
      Object.values(CALCULATOR_LABELS),
    );
  });

  it('label the paycheck as the "Your paycheck" card does', () => {
    const labels = captures(section('Your paycheck'), /<td class="label">(?:<strong>)?([^<]+)/g);
    expect(labels.filter((label) => label !== 'Pay date').sort()).toEqual(
      [
        PAYCHECK_TILES.gross,
        PAYCHECK_TILES.net,
        ...PAYCHECK_LINES.map(([, label]) => label),
      ].sort(),
    );
  });
});
