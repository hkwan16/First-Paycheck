import { describe, expect, it } from 'vitest';
import { accountSummary } from './account';

const user = (email: string | undefined, metadata: Record<string, unknown> = {}) => ({
  email,
  user_metadata: metadata,
});

describe('accountSummary', () => {
  it("labels the account with the person's name when the profile has one", () => {
    expect(accountSummary(user('alex@example.com', { full_name: ' Alex Rivera ' })).label).toBe(
      'Alex Rivera',
    );
    expect(accountSummary(user('alex@example.com', { name: 'Alex' })).label).toBe('Alex');
  });

  it('falls back to the email, then to a generic label', () => {
    expect(accountSummary(user('alex@example.com', { full_name: '  ', name: 42 })).label).toBe(
      'alex@example.com',
    );
    expect(accountSummary(user(undefined)).label).toBe('Account');
  });

  it('marks the sample-data account only when its email matches, ignoring case and spaces', () => {
    const e2e = user('E2E@example.com');
    expect(accountSummary(e2e, ' e2e@EXAMPLE.com ').sampleData).toBe(true);
    expect(accountSummary(e2e, 'someone@example.com').sampleData).toBe(false);
    expect(accountSummary(e2e, undefined).sampleData).toBe(false);
    expect(accountSummary(e2e, '').sampleData).toBe(false);
    expect(accountSummary(user(undefined), '').sampleData).toBe(false);
  });
});
