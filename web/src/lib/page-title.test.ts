import { describe, expect, it } from 'vitest';
import { pageTitle, SITE_NAME, TITLE_TEMPLATE } from './page-title';

describe('pageTitle', () => {
  it('writes a page title the way the root layout template does', () => {
    expect(pageTitle('Confirm benefits summary')).toBe('Confirm benefits summary | First Paycheck');
    expect(TITLE_TEMPLATE.replace('%s', 'Decisions')).toBe(pageTitle('Decisions'));
    expect(SITE_NAME).toBe('First Paycheck');
  });
});
